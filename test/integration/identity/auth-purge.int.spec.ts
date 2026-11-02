import { Logger } from '@nestjs/common';
import pg from 'pg';
import { createDatabase } from '../../../src/database/database.module.js';
import { loadConfig } from '../../../src/config/app-config.js';
import { AuthPurge } from '../../../src/identity/auth-purge.js';
import { startPostgres, runFlyway, type PostgresHandle } from '../../support/containers.js';
import { testEnv } from '../../support/test-env.js';

let postgres: PostgresHandle;
let db: pg.Client;

beforeAll(async () => {
  postgres = await startPostgres();
  const result = await runFlyway(postgres.internalUrl, postgres.network, 'migrate');
  if (result.exitCode !== 0) throw new Error(`Flyway falló:\n${result.output}`);
  db = new pg.Client({ connectionString: postgres.databaseUrl });
  await db.connect();
}, 300_000);
afterAll(async () => {
  await db?.end();
  await postgres?.stop();
});

function purgeAgainst(databaseUrl: string) {
  const config = loadConfig({ ...testEnv, DATABASE_URL: databaseUrl });
  const kysely = createDatabase(config.database);
  return { purge: new AuthPurge(kysely), close: () => kysely.destroy() };
}

const hash = (n: number) => n.toString(16).padStart(64, '0');
let counter = 0;

/** Una sesión con su token de renovación y un enlace de correo, vencidos hace `ago`. */
async function expiredAgo(ago: string) {
  counter++;
  const user = (
    await db.query<{ id: string }>(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [
      `purga-${counter}-${Date.now()}@example.test`,
    ])
  ).rows[0]!.id;
  const session = (
    await db.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, now() - CAST($2 AS interval)) RETURNING id`,
      [user, ago],
    )
  ).rows[0]!.id;
  await db.query('INSERT INTO auth_refresh_tokens (token_hash, session_id) VALUES ($1, $2)', [
    hash(counter * 2),
    session,
  ]);
  const link = (
    await db.query<{ id: string }>(
      `INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at)
       VALUES ($1, 'RESET_PASSWORD', $2, now() - CAST($3 AS interval)) RETURNING id`,
      [user, hash(counter * 2 + 1), ago],
    )
  ).rows[0]!.id;
  return { session, link };
}

const exists = async (table: string, column: string, id: string) =>
  (await db.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id])).rowCount === 1;

it('borra lo vencido hace más de 7 días, con sus tokens de renovación, y conserva lo reciente', async () => {
  const old = await expiredAgo('8 days');
  const recent = await expiredAgo('6 days');
  const live = await expiredAgo('-1 day'); // vence mañana
  const { purge, close } = purgeAgainst(postgres.databaseUrl);
  const lines: string[] = [];
  const spy = vi.spyOn(Logger.prototype, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await purge.purge();
  } finally {
    spy.mockRestore();
    await close();
  }
  expect(await exists('auth_sessions', 'id', old.session)).toBe(false);
  expect(await exists('auth_refresh_tokens', 'session_id', old.session)).toBe(false);
  expect(await exists('user_tokens', 'id', old.link)).toBe(false);
  for (const kept of [recent, live]) {
    expect(await exists('auth_sessions', 'id', kept.session)).toBe(true);
    expect(await exists('auth_refresh_tokens', 'session_id', kept.session)).toBe(true);
    expect(await exists('user_tokens', 'id', kept.link)).toBe(true);
  }
  expect(lines.some((l) => l.includes('1 sesiones y 1 enlaces vencidos borrados'))).toBe(true);
});

it('sin nada que borrar no registra nada', async () => {
  await db.query(`DELETE FROM auth_sessions WHERE expires_at < now() - interval '7 days'`);
  await db.query(`DELETE FROM user_tokens WHERE expires_at < now() - interval '7 days'`);
  const { purge, close } = purgeAgainst(postgres.databaseUrl);
  const spy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  try {
    await purge.purge();
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    await close();
  }
});

it('con la base caída no lanza: solo avisa', async () => {
  const { purge, close } = purgeAgainst('postgresql://app:secreto-de-prueba@127.0.0.1:1/einvoice');
  const lines: string[] = [];
  const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await expect(purge.purge()).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('La purga de sesiones vencidas falló'))).toBe(true);
    expect(lines.join('\n')).not.toContain('secreto-de-prueba');
  } finally {
    spy.mockRestore();
    await close();
  }
});
