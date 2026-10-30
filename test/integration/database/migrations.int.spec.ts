import { Test } from '@nestjs/testing';
import { Global, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_CONFIG, loadConfig } from '../../../src/config/app-config.js';
import { DATABASE, DatabaseModule } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { migratedDatabase, runFlyway, startPostgres } from '../../support/containers.js';
import { testEnv } from '../../support/test-env.js';

async function query(url: string, sql: string): Promise<Record<string, any>[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
}

/** Módulo de prueba que da APP_CONFIG con la DATABASE_URL del contenedor. */
function configFor(databaseUrl: string) {
  @Global()
  @Module({
    providers: [{ provide: APP_CONFIG, useValue: loadConfig({ ...testEnv, DATABASE_URL: databaseUrl }) }],
    exports: [APP_CONFIG],
  })
  class TestConfigModule {}
  return TestConfigModule;
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('migraciones con Flyway', () => {
  it('Flyway 12.4.0 aplica V1–V19 sobre una base vacía y valida sus checksums', async () => {
    const pgc = await startPostgres();
    cleanups.push(() => pgc.stop());
    expect((await runFlyway(pgc.internalUrl, pgc.network, 'migrate')).exitCode).toBe(0);
    const rows = await query(
      pgc.databaseUrl,
      'SELECT version, success FROM flyway_schema_history WHERE version IS NOT NULL ORDER BY installed_rank',
    );
    expect(rows.map((r) => r.version)).toEqual(Array.from({ length: 19 }, (_, i) => String(i + 1)));
    expect(rows.every((r) => r.success)).toBe(true);
    expect((await runFlyway(pgc.internalUrl, pgc.network, 'validate')).exitCode).toBe(0);
  });

  it('con currentSchema migra y consulta en ese esquema', async () => {
    const pgc = await startPostgres();
    cleanups.push(() => pgc.stop());
    const withSchema = (url: string) => `${url}?currentSchema=einvoice&sslmode=disable`;
    const run = await runFlyway(withSchema(pgc.internalUrl), pgc.network, 'migrate');
    expect(run.exitCode, run.output).toBe(0);

    const tables = await query(
      pgc.databaseUrl,
      "SELECT table_schema FROM information_schema.tables WHERE table_name = 'tenants'",
    );
    expect(tables.map((t) => t.table_schema)).toEqual(['einvoice']);

    const moduleRef = await Test.createTestingModule({
      imports: [configFor(withSchema(pgc.databaseUrl)), DatabaseModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    cleanups.push(() => app.close());
    const db = app.get<Kysely<DB>>(DATABASE);
    expect(await db.selectFrom('tenants').select('id').execute()).toEqual([]);
  });

  it('migrate.sh sin credenciales en la URL usa SPRING_FLYWAY_USER y SPRING_FLYWAY_PASSWORD', async () => {
    const pgc = await startPostgres();
    cleanups.push(() => pgc.stop());
    const bare = pgc.internalUrl.replace(/\/\/[^@]*@/, '//');
    const run = await runFlyway(bare, pgc.network, 'migrate', {
      SPRING_FLYWAY_USER: 'test',
      SPRING_FLYWAY_PASSWORD: 'test',
    });
    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).not.toContain('SPRING_FLYWAY_PASSWORD');
  });

  it('DatabaseModule ejecuta SELECT 1 y cierra el pool al cerrar la app', async () => {
    const db0 = await migratedDatabase();
    cleanups.push(() => db0.stop());
    const moduleRef = await Test.createTestingModule({
      imports: [configFor(db0.databaseUrl), DatabaseModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const db = app.get<Kysely<DB>>(DATABASE);
    const { rows } = await (await import('kysely')).sql<{ ok: number }>`SELECT 1 AS ok`.execute(db);
    expect(rows).toEqual([{ ok: 1 }]);
    await app.close();
    await expect(db.selectFrom('tenants').select('id').execute()).rejects.toThrow();
  });
});
