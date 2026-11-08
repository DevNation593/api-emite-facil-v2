import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { generateApiKey } from '../../../src/apikey/api-key-credential.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { billingScenario, customerJson, invoiceJson } from '../../support/scenario.js';
import {
  registerAndLogin,
  startTestApp,
  type TestApp,
} from '../../support/test-app.js';

/**
 * Un sistema externo llama con X-Api-Key. Aquí las keys se insertan por SQL para probar solo la
 * comprobación; las creadas por la API se prueban en api-key-api.int.spec.ts. La ruta que recorre
 * la key es la pública /actuator/health (la key se comprueba igual) y las de persona, que la
 * rechazan con 403.
 */
const KEY_HEADER = 'X-Api-Key';
const UNAUTHENTICATED = 'Se requiere un token de acceso válido';

let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let key: string;
let keyId: string;
let publicId: string;
let secret: string;
let bearer: string;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});

const http = () => testApp.http;

/** Una empresa y una key activa a nombre de un usuario nuevo. */
async function newKey(userId: string, name = 'ERP Contable') {
  const tenant = await db.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('Empresa de prueba') RETURNING id`,
  );
  const generated = generateApiKey();
  const row = await db.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, created_by, name, public_id, secret_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenant.rows[0]!.id, userId, name, generated.publicId, generated.secretHash],
  );
  return { value: generated.value, id: row.rows[0]!.id, publicId: generated.publicId };
}

beforeEach(async () => {
  const user = await registerAndLogin(http());
  bearer = `Bearer ${user.accessToken}`;
  const created = await newKey(user.userId);
  key = created.value;
  keyId = created.id;
  publicId = created.publicId;
  secret = key.slice('efk_'.length + 13);
});

const withKey = (value: string) => http().get('/actuator/health').set(KEY_HEADER, value);
const lastUsedAt = async () =>
  (await db.query<{ t: Date | null }>('SELECT last_used_at AS t FROM api_keys WHERE id = $1', [keyId]))
    .rows[0]!.t;

it('una key válida pasa', async () => {
  await withKey(key).expect(200);
});

it('las keys inválidas responden todas lo mismo', async () => {
  await db.query('UPDATE api_keys SET revoked_at = now(), revoked_by = created_by WHERE id = $1', [keyId]);
  const other = await db.query<{ id: string }>('SELECT created_by AS id FROM api_keys WHERE id = $1', [keyId]);
  const second = await newKey(other.rows[0]!.id, 'Vieja');
  await db.query('UPDATE api_keys SET revoked_at = now(), revoked_by = created_by WHERE id = $1', [second.id]);
  const bad = [
    'efk_corta',
    `efk_ZZZZZZZZZZZZ_${secret}`,
    `efk_${publicId}_${'A'.repeat(43)}`,
    key, // revocada
    second.value, // revocada
  ];
  const bodies: string[] = [];
  for (const value of bad) {
    const res = await withKey(value).expect(401);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.body.errorCode).toBe('UNAUTHENTICATED');
    expect(res.body.detail).toBe(UNAUTHENTICATED);
    bodies.push(`${res.body.status}|${res.body.title}|${res.body.errorCode}|${res.body.detail}`);
  }
  expect(new Set(bodies).size).toBe(1);
});

it('una cabecera vacía se rechaza', async () => {
  await withKey('').expect(401);
  await withKey('   ').expect(401);
});

it('los espacios alrededor se ignoran', async () => {
  await withKey(`  ${key}  `).expect(200);
});

it('una key revocada deja de servir en la petición siguiente', async () => {
  await withKey(key).expect(200);
  await db.query('UPDATE api_keys SET revoked_at = now(), revoked_by = created_by WHERE id = $1', [keyId]);
  await withKey(key).expect(401);
});

it('las dos credenciales a la vez son ambiguas', async () => {
  for (const value of [key, '']) {
    const res = await http()
      .get('/actuator/health')
      .set(KEY_HEADER, value)
      .set('Authorization', bearer)
      .expect(400);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.body).toMatchObject({
      errorCode: 'CREDENTIALS_AMBIGUOUS',
      detail: 'Envíe X-Api-Key o Authorization, no las dos',
    });
  }
  // Cualquier Authorization cuenta, también otro esquema.
  await http()
    .get('/actuator/health')
    .set(KEY_HEADER, key)
    .set('Authorization', 'Basic YTpi')
    .expect(400);
});

it('los endpoints de persona rechazan las keys', async () => {
  const calls = [
    () => http().get('/api/v1/auth/me'),
    () =>
      http()
        .post('/api/v1/auth/password')
        .send({ currentPassword: 'una-clave-cualquiera', newPassword: 'otra-clave-bien-larga' }),
    () => http().post('/api/v1/auth/email-verification/resend'),
  ];
  for (const call of calls) {
    const res = await call().set(KEY_HEADER, key).expect(403);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.body.errorCode).toBe('API_KEY_NOT_ALLOWED');
  }
});

it('last_used_at se escribe como mucho una vez por minuto', async () => {
  expect(await lastUsedAt()).toBeNull();
  await withKey(key).expect(200);
  const first = await lastUsedAt();
  expect(first).not.toBeNull();
  await withKey(key).expect(200);
  expect(await lastUsedAt()).toEqual(first);

  await db.query(`UPDATE api_keys SET last_used_at = now() - interval '2 minutes' WHERE id = $1`, [keyId]);
  const old = await lastUsedAt();
  await withKey(key).expect(200);
  expect((await lastUsedAt())!.getTime()).toBeGreaterThan(old!.getTime());
});

it('el valor de la key nunca llega a los logs', async () => {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
    }),
  );
  try {
    await withKey(key).expect(200);
    await withKey(`efk_${publicId}_${'B'.repeat(43)}`).expect(401);
    await http()
      .get('/actuator/health')
      .set(KEY_HEADER, key)
      .set('Authorization', bearer)
      .expect(400);
    const all = lines.join('\n');
    expect(all).not.toContain(secret);
    expect(all).not.toContain(key);
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
});

describe('con la base caída', () => {
  /** Una aplicación cuya base no responde; la key se comprueba contra ella. */
  async function withoutDatabase(): Promise<TestApp> {
    return startTestApp(stack, {
      DATABASE_URL: 'postgresql://app:app@127.0.0.1:1/einvoice',
    });
  }

  it('un fallo al comprobar la key no es un 401', async () => {
    const down = await withoutDatabase();
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      const res = await down.http.get('/actuator/health').set(KEY_HEADER, key).expect(503);
      expect(res.headers['content-type']).toBe('application/problem+json');
      expect(res.body).toMatchObject({
        errorCode: 'INTERNAL_ERROR',
        detail: 'No se pudo comprobar la API key; vuelva a intentar en un momento',
      });
      expect(res.body.correlationId).toBeTruthy();
      expect(lines.join('\n')).not.toContain(key);
      expect(lines.join('\n')).not.toContain(secret);
    } finally {
      spy.mockRestore();
      await down.close();
    }
  });

  it('una key con formato inválido sigue siendo 401: no se consulta la base', async () => {
    const down = await withoutDatabase();
    try {
      await down.http.get('/actuator/health').set(KEY_HEADER, 'efk_corta').expect(401);
    } finally {
      await down.close();
    }
  });
});

it('un fallo al anotar el último uso no falla la petición', async () => {
  const lines: string[] = [];
  const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  // Un disparador que hace fallar cualquier UPDATE de last_used_at; la lectura de la key sigue funcionando.
  await db.query(`
    CREATE OR REPLACE FUNCTION fail_touch() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'base caida'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_touch BEFORE UPDATE OF last_used_at ON api_keys
      FOR EACH ROW EXECUTE FUNCTION fail_touch();
  `);
  try {
    await withKey(key).expect(200);
    expect(lines.some((l) => l.includes(keyId))).toBe(true);
    expect(lines.join('\n')).not.toContain(key);
  } finally {
    spy.mockRestore();
    await db.query('DROP TRIGGER fail_touch ON api_keys');
  }
});

describe('con una empresa lista para facturar', () => {
  let scenario: Awaited<ReturnType<typeof billingScenario>>;
  let billerKey: string;
  let billerKeyId: string;

  beforeEach(async () => {
    scenario = await billingScenario(http(), db);
    const created = await http()
      .post('/api/v1/api-keys')
      .set('Authorization', `Bearer ${scenario.owner}`)
      .set('X-Tenant-Id', scenario.tenant)
      .send({ name: 'ERP Contable' })
      .expect(201);
    billerKey = created.body.key as string;
    billerKeyId = created.body.id as string;
  });

  const issueWithKey = () =>
    http()
      .post('/api/v1/invoices')
      .set(KEY_HEADER, billerKey)
      .set('Idempotency-Key', randomUUID())
      .send(invoiceJson(scenario, '1', '11.50'));

  it('una key emite y lee una factura', async () => {
    const issued = await issueWithKey().expect(202);
    const id = issued.body.id as string;

    const document = await http().get(`/api/v1/documents/${id}`).set(KEY_HEADER, billerKey).expect(200);
    expect(document.body.id).toBe(id);
    const current = await http().get('/api/v1/tenants/current').set(KEY_HEADER, billerKey).expect(200);
    expect(current.body).toMatchObject({ id: scenario.tenant, role: 'BILLER' });
  });

  it('la auditoría nombra la key y a quien la creó', async () => {
    const creator = (
      await db.query<{ created_by: string }>('SELECT created_by FROM api_keys WHERE id = $1', [billerKeyId])
    ).rows[0]!.created_by;
    const issued = await issueWithKey().expect(202);
    const documentId = issued.body.id as string;
    await http()
      .post('/api/v1/customers')
      .set(KEY_HEADER, billerKey)
      .send(customerJson('06', 'PA1234567', 'María Pérez'))
      .expect(201);

    for (const action of ['INVOICE_RESERVED', 'CUSTOMER_CREATED']) {
      const rows = await db.query<{ actor_id: string; api_key_id: string }>(
        'SELECT actor_id, api_key_id FROM audit_events WHERE tenant_id = $1 AND action = $2 AND api_key_id = $3',
        [scenario.tenant, action, billerKeyId],
      );
      expect(rows.rows, action).toEqual([{ actor_id: creator, api_key_id: billerKeyId }]);
    }
    const createdBy = await db.query<{ created_by: string }>('SELECT created_by FROM fiscal_documents WHERE id = $1', [
      documentId,
    ]);
    expect(createdBy.rows[0]!.created_by).toBe(creator);

    // El mismo dueño con su sesión: el evento no lleva key.
    const own = await http()
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${scenario.owner}`)
      .set('X-Tenant-Id', scenario.tenant)
      .send(customerJson('06', 'PA7654321', 'Ana Ruiz'))
      .expect(201);
    const ownEvents = await db.query<{ api_key_id: string | null }>(
      "SELECT api_key_id FROM audit_events WHERE action = 'CUSTOMER_CREATED' AND entity_id = $1",
      [own.body.id],
    );
    expect(ownEvents.rows).toEqual([{ api_key_id: null }]);
  });
});
