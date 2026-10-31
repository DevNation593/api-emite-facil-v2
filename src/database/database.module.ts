import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import type { DB } from './schema.js';

/** Token de inyección del cliente Kysely. */
export const DATABASE = Symbol('DATABASE');

/**
 * sslmode de la URL (formato JDBC/libpq) a la opción ssl de pg. parseDatabaseUrl solo deja pasar
 * estos cuatro valores; sin sslmode la conexión va sin TLS.
 */
export function sslOption(mode: string | undefined): pg.PoolConfig['ssl'] {
  switch (mode) {
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-ca':
      // Verifica la cadena de confianza pero no el nombre del servidor, como libpq.
      return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case 'verify-full':
      return true;
    case 'disable':
      return false;
    default:
      return undefined;
  }
}

const DATE_OID = 1082;

/**
 * Las columnas `date` (LocalDate en Java) llegan como el texto 'YYYY-MM-DD': el parser por
 * defecto de pg las convierte en Date a medianoche local y, en un proceso en UTC, la fecha
 * fiscal que alimenta la clave de acceso puede salir un día antes.
 */
const dateAsText: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === DATE_OID
      ? (value: string) => value
      : pg.types.getTypeParser(oid, format as 'text')) as pg.CustomTypesConfig['getTypeParser'],
};

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
    // Como el connection-timeout predeterminado de Hikari en la API Java (30 s): una petición
    // que espera conexión bajo carga no debe fallar antes que en Java. El health y el cierre
    // llevan sus propios plazos.
    connectionTimeoutMillis: 30_000,
    ssl: sslOption(config.params['sslmode']),
    types: dateAsText,
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
