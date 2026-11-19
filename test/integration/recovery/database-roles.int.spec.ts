import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { runFlyway, startPostgres, type PostgresHandle } from '../../support/containers.js';

/*
 * Traducción de recovery/DatabaseRolesIT.java: con infra/postgres/roles.sql, quien migra es dueño de las tablas y
 * la aplicación opera con un usuario que solo lee y escribe filas: no puede retirar las defensas de la base. Las
 * órdenes corren dentro del contenedor de PostgreSQL, como en Java.
 */
const MIGRATOR_PASSWORD = 'clave-del-migrador-de-prueba';
const APP_PASSWORD = 'clave-de-la-aplicacion-de-prueba';
const ROLES_SQL = path.resolve('infra/postgres/roles.sql');
const RESTORE_SCRIPT = path.resolve('infra/backup/restore.sh');

let postgres: PostgresHandle;
let database: string;
let app: pg.Client;

const superuser = () => postgres.container.getUsername();

async function exec(command: string[]): Promise<{ exitCode: number; output: string }> {
  const result = await postgres.container.exec(command);
  return { exitCode: result.exitCode, output: result.output };
}

async function execOk(command: string[]): Promise<void> {
  const result = await exec(command);
  expect(result.exitCode, `${command.join(' ')}\n${result.output}`).toBe(0);
}

/** URL de una base del servidor con ese usuario, desde el host o desde la red de los contenedores. */
function url(base: string, name: string, user: string, password: string): string {
  const parsed = new URL(base);
  parsed.username = user;
  parsed.password = password;
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function applyRoles(name: string): Promise<void> {
  await execOk([
    'psql',
    '-U',
    superuser(),
    '-d',
    name,
    '-v',
    'ON_ERROR_STOP=1',
    '-v',
    `db=${name}`,
    '-v',
    `migrator_password=${MIGRATOR_PASSWORD}`,
    '-v',
    `app_password=${APP_PASSWORD}`,
    '-f',
    '/tmp/roles.sql',
  ]);
}

async function restoreAsMigrator(name: string): Promise<{ exitCode: number; output: string }> {
  return exec([
    'env',
    'PGUSER=einvoice_migrator',
    `PGPASSWORD=${MIGRATOR_PASSWORD}`,
    'PGHOST=127.0.0.1',
    'bash',
    '-c',
    `cd /tmp && sha256sum ${name}.dump > ${name}.dump.sha256 && bash /tmp/restore.sh /tmp/${name}.dump ${name}`,
  ]);
}

beforeAll(async () => {
  postgres = await startPostgres();
  await postgres.container.copyFilesToContainer([
    { source: ROLES_SQL, target: '/tmp/roles.sql' },
    { source: RESTORE_SCRIPT, target: '/tmp/restore.sh' },
  ]);
  database = `roles_${randomUUID().replaceAll('-', '')}`;
  await execOk(['createdb', '-U', superuser(), database]);
  await applyRoles(database);
  const migrated = await runFlyway(
    url(postgres.internalUrl, database, 'einvoice_migrator', MIGRATOR_PASSWORD),
    postgres.network,
    'migrate',
  );
  expect(migrated.exitCode, migrated.output).toBe(0);
  app = new pg.Client({ connectionString: url(postgres.databaseUrl, database, 'einvoice_app', APP_PASSWORD) });
  await app.connect();
}, 300_000);
afterAll(async () => {
  await app?.end();
  await postgres?.stop();
});

/** 42501: permiso insuficiente. */
async function expectDenied(client: pg.Client, sql: string): Promise<void> {
  await expect(client.query(sql), sql).rejects.toMatchObject({ code: '42501' });
}

it('aBackupRestoresIntoTheTwoRoleSetup', async () => {
  const tenant = (await app.query<{ id: string }>("INSERT INTO tenants (name) VALUES ('Respaldada') RETURNING id")).rows[0]!
    .id;
  const restoredName = `roles_restaurada_${randomUUID().replaceAll('-', '')}`;
  await execOk(['pg_dump', '-U', superuser(), '-Fc', '-f', `/tmp/${restoredName}.dump`, database]);

  // El orden que documenta infra/backup/restore.sh: base vacía, roles, y restaurar como quien migra.
  await execOk(['createdb', '-U', superuser(), restoredName]);
  await applyRoles(restoredName);
  const restore = await restoreAsMigrator(restoredName);
  expect(restore.exitCode, restore.output).toBe(0);

  // Quien migra es dueño de lo restaurado: la aplicación arrancaría y podría seguir migrando.
  const validated = await runFlyway(
    url(postgres.internalUrl, restoredName, 'einvoice_migrator', MIGRATOR_PASSWORD),
    postgres.network,
    'validate',
  );
  expect(validated.exitCode, validated.output).toBe(0);
  // Y la aplicación opera con su usuario, que sigue sin poder retirar las defensas.
  const restored = new pg.Client({
    connectionString: url(postgres.databaseUrl, restoredName, 'einvoice_app', APP_PASSWORD),
  });
  await restored.connect();
  try {
    expect((await restored.query('SELECT name FROM tenants WHERE id = $1', [tenant])).rows).toEqual([
      { name: 'Respaldada' },
    ]);
    expect((await restored.query("UPDATE tenants SET name = 'Restaurada' WHERE id = $1", [tenant])).rowCount).toBe(1);
    await expectDenied(restored, 'TRUNCATE document_artifacts');
    await expectDenied(restored, 'ALTER TABLE document_artifacts DISABLE TRIGGER ALL');
  } finally {
    await restored.end();
  }
}, 180_000);

it('aRestoreThatFailsHalfwayLeavesTheDatabaseEmptyToTryAgain', async () => {
  const restoredName = `roles_fallida_${randomUUID().replaceAll('-', '')}`;
  // Un volcado que concede permisos a un rol que el servidor de destino no tiene: los datos se cargan y la
  // restauración falla después, al llegar a los permisos.
  await execOk([
    'psql',
    '-U',
    superuser(),
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'CREATE ROLE rol_que_no_estara; GRANT SELECT ON tenants TO rol_que_no_estara',
  ]);
  try {
    await execOk(['pg_dump', '-U', superuser(), '-Fc', '-f', `/tmp/${restoredName}.dump`, database]);
  } finally {
    await execOk([
      'psql',
      '-U',
      superuser(),
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'REVOKE ALL ON tenants FROM rol_que_no_estara; DROP ROLE rol_que_no_estara',
    ]);
  }
  await execOk(['createdb', '-U', superuser(), restoredName]);
  await applyRoles(restoredName);

  const restore = await restoreAsMigrator(restoredName);

  expect(restore.exitCode, restore.output).not.toBe(0);
  // Nada quedó a medias: se puede corregir la causa y restaurar de nuevo en la misma base.
  const tables = await exec([
    'psql',
    '-U',
    superuser(),
    '-d',
    restoredName,
    '-At',
    '-c',
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
  ]);
  expect(tables.output.trim()).toBe('0');
}, 180_000);

it('theApplicationRoleReadsAndWritesRows', async () => {
  const tenant = (await app.query<{ id: string }>("INSERT INTO tenants (name) VALUES ('Comercial Andina') RETURNING id"))
    .rows[0]!.id;

  expect((await app.query("UPDATE tenants SET name = 'Andina' WHERE id = $1", [tenant])).rowCount).toBe(1);
  expect((await app.query('SELECT name FROM tenants WHERE id = $1', [tenant])).rows).toEqual([{ name: 'Andina' }]);
  expect(Number((await app.query('SELECT count(*) AS n FROM tax_rates')).rows[0].n)).toBeGreaterThan(0);

  // API keys: alta, consulta, revocación y el bloqueo de la empresa que serializa las altas.
  const user = (
    await app.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [
      `roles-${randomUUID()}@example.test`,
    ])
  ).rows[0]!.id;
  const key = (
    await app.query<{ id: string }>(
      `INSERT INTO api_keys (tenant_id, created_by, name, public_id, secret_hash)
       VALUES ($1, $2, 'ERP', 'AbCdEf123456', $3) RETURNING id`,
      [tenant, user, '0'.repeat(64)],
    )
  ).rows[0]!.id;
  expect((await app.query('SELECT name FROM api_keys WHERE id = $1', [key])).rows).toEqual([{ name: 'ERP' }]);
  expect((await app.query('UPDATE api_keys SET revoked_at = now(), revoked_by = $1 WHERE id = $2', [user, key])).rowCount).toBe(
    1,
  );
  await app.query('BEGIN');
  try {
    expect((await app.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenant])).rows).toEqual([{ id: tenant }]);
  } finally {
    await app.query('COMMIT');
  }
  expect((await app.query('DELETE FROM api_keys WHERE id = $1', [key])).rowCount).toBe(1);

  expect((await app.query('DELETE FROM tenants WHERE id = $1', [tenant])).rowCount).toBe(1);
});

it('theApplicationRoleCannotRemoveTheDatabaseDefences', async () => {
  await expectDenied(app, 'ALTER TABLE document_artifacts DISABLE TRIGGER ALL');
  await expectDenied(app, 'DROP TRIGGER document_artifacts_immutable ON document_artifacts');
  await expectDenied(app, 'TRUNCATE document_artifacts');
  await expectDenied(app, 'ALTER TABLE state_events DISABLE TRIGGER ALL');
  await expectDenied(app, 'DROP TRIGGER state_events_append_only ON state_events');
  await expectDenied(app, 'TRUNCATE state_events');
  await expectDenied(app, 'ALTER TABLE audit_events DISABLE TRIGGER ALL');
  await expectDenied(app, 'TRUNCATE audit_events');
  await expectDenied(app, 'ALTER TABLE taxpayers DROP CONSTRAINT taxpayers_production_needs_activation');
  await expectDenied(app, 'DROP TABLE audit_events');
  await expectDenied(app, 'CREATE TABLE intrusa (id int)');
});
