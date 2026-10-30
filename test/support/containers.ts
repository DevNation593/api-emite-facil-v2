import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Network, type StartedNetwork, Wait } from 'testcontainers';

// Mismas versiones que infra/docker-compose.yml y que la API Java.
const POSTGRES_IMAGE = 'postgres:16';
const FLYWAY_IMAGE = 'flyway/flyway:12.4.0';
const ALIAS = 'postgres';
const USER = 'test';
const PASSWORD = 'test';
const DATABASE_NAME = 'einvoice';

// Rutas absolutas del host: en Windows Docker Desktop no acepta relativas para los montajes.
const root = path.resolve(import.meta.dirname, '..', '..');
export const migrationsDir = path.join(root, 'db', 'migration');
const migrateScript = path.join(root, 'scripts', 'migrate.sh');
const connectionUrlScript = path.join(root, 'infra', 'connection-url.sh');

export interface PostgresHandle {
  container: StartedPostgreSqlContainer;
  network: StartedNetwork;
  /** URL para conectarse desde el host. */
  databaseUrl: string;
  /** URL para otro contenedor de la misma red (alias de red en vez de localhost). */
  internalUrl: string;
  /** Detiene la base y luego la red (en ese orden: la red no se borra con endpoints activos). */
  stop(): Promise<void>;
}

export async function startPostgres(): Promise<PostgresHandle> {
  const network = await new Network().start();
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(DATABASE_NAME)
    .withUsername(USER)
    .withPassword(PASSWORD)
    .withNetwork(network)
    .withNetworkAliases(ALIAS)
    .start();
  return {
    container,
    network,
    databaseUrl: container.getConnectionUri(),
    internalUrl: `postgresql://${USER}:${PASSWORD}@${ALIAS}:5432/${DATABASE_NAME}`,
    stop: async () => {
      await container.stop();
      await network.stop();
    },
  };
}

/**
 * Corre scripts/migrate.sh dentro de la imagen de Flyway. El código de salida se lee del propio
 * contenedor (se imprime al final) porque Testcontainers no lo expone tras una ejecución única.
 */
export async function runFlyway(
  internalUrl: string,
  network: StartedNetwork,
  command: 'migrate' | 'validate' | 'info' = 'migrate',
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; output: string }> {
  const container = await new GenericContainer(FLYWAY_IMAGE)
    .withNetwork(network)
    .withEnvironment({ DATABASE_URL: internalUrl, ...extraEnv })
    .withBindMounts([
      { source: migrationsDir, target: '/flyway/sql', mode: 'ro' },
      { source: migrateScript, target: '/scripts/migrate.sh', mode: 'ro' },
      { source: connectionUrlScript, target: '/scripts/connection-url.sh', mode: 'ro' },
    ])
    .withEntrypoint(['sh', '-c', 'sh /scripts/migrate.sh "$0"; echo "FLYWAY_EXIT_CODE=$?"', command])
    .withWaitStrategy(Wait.forLogMessage(/FLYWAY_EXIT_CODE=\d+/))
    .withStartupTimeout(120_000)
    .start();
  try {
    const chunks: string[] = [];
    const stream = await container.logs();
    for await (const chunk of stream) chunks.push(String(chunk));
    const output = chunks.join('');
    const match = /FLYWAY_EXIT_CODE=(\d+)/.exec(output);
    return { exitCode: match ? Number(match[1]) : -1, output };
  } finally {
    await container.stop();
  }
}

export async function migratedDatabase(): Promise<{ databaseUrl: string; stop(): Promise<void> }> {
  const pg = await startPostgres();
  const stop = () => pg.stop();
  try {
    const result = await runFlyway(pg.internalUrl, pg.network, 'migrate');
    if (result.exitCode !== 0) throw new Error(`Flyway falló:\n${result.output}`);
  } catch (error) {
    await stop();
    throw error;
  }
  return { databaseUrl: pg.databaseUrl, stop };
}
