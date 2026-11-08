import type { Kysely } from 'kysely';
import pg from 'pg';
import { loadConfig } from '../../src/config/app-config.js';
import { createDatabase } from '../../src/database/database.module.js';
import type { DB } from '../../src/database/schema.js';
import { migratedDatabase } from './containers.js';
import { testEnv } from './test-env.js';

export interface DbHandle {
  /** Cliente suelto para sembrar y consultar por SQL. */
  pgc: pg.Client;
  /** La misma Kysely con que arranca la aplicación (fechas como texto). */
  db: Kysely<DB>;
  stop(): Promise<void>;
}

/** Una base migrada con Flyway, sin levantar la aplicación. */
export async function startDb(): Promise<DbHandle> {
  const database = await migratedDatabase();
  const pgc = new pg.Client({ connectionString: database.databaseUrl });
  await pgc.connect();
  const db = createDatabase(
    loadConfig({ ...testEnv, DATABASE_URL: database.databaseUrl }).database,
  );
  return {
    pgc,
    db,
    stop: async () => {
      await db.destroy();
      await pgc.end();
      await database.stop();
    },
  };
}
