import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import type { DB } from './schema.js';

/** Token de inyección del cliente Kysely. */
export const DATABASE = Symbol('DATABASE');

/** sslmode de la URL (formato JDBC/libpq) a la opción ssl de pg. Otros valores dejan el predeterminado de pg. */
function sslOption(mode: string | undefined): pg.PoolConfig['ssl'] {
  switch (mode) {
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-full':
      return true;
    case 'disable':
      return false;
    default:
      return undefined;
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * pg.Pool es perezoso: no abre conexiones hasta la primera consulta, así que crear la aplicación
 * no necesita la base. pg no mantiene un mínimo de conexiones: poolMinIdle se ignora.
 */
export function createDatabase(config: AppConfig['database']): Kysely<DB> {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.poolSize,
    idleTimeoutMillis: 120_000,
    // Mismo plazo que la comprobación de health: sin él, un servidor que acepta y no
    // completa el handshake dejaría cada consulta pendiente para siempre.
    connectionTimeoutMillis: 2_000,
    ssl: sslOption(config.params['sslmode']),
  });
  if (config.schema !== null) {
    const setSearchPath = `SET search_path TO ${quoteIdentifier(config.schema)}`;
    // La consulta queda en la cola del cliente, antes que cualquiera del llamador.
    pool.on('connect', (client) => {
      client.query(setSearchPath).catch(() => {
        // Si la conexión cayó, la consulta del llamador fallará con el error real.
      });
    });
  }
  // Un error en una conexión ociosa no debe tumbar el proceso; pg descarta ese cliente.
  pool.on('error', () => undefined);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (config: AppConfig) => createDatabase(config.database),
      inject: [APP_CONFIG],
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
