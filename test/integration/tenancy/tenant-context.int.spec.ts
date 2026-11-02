import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { generateApiKey } from '../../../src/apikey/api-key-credential.js';
import { AccessTokens } from '../../../src/identity/access-tokens.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { testConfig } from '../../support/test-env.js';
import { registerAndLogin, startTestApp, type TestApp } from '../../support/test-app.js';

const CURRENT = '/api/v1/tenants/current';
const TENANT_HEADER = 'X-Tenant-Id';
const UNAUTHENTICATED = 'Se requiere un token de acceso válido';

let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;

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
const bearer = (token: string) => `Bearer ${token}`;

async function newUser() {
  return registerAndLogin(http());
}

async function createTenant(token: string): Promise<string> {
  const res = await http()
    .post('/api/v1/tenants')
    .set('Authorization', bearer(token))
    .send({ name: 'Empresa' })
    .expect(201);
  return (res.body as { id: string }).id;
}

/** Una empresa sembrada por SQL y un usuario con ese rol en ella. */
async function member(role: string) {
  const tenant = (
    await db.query<{ id: string }>(`INSERT INTO tenants (name) VALUES ('Sembrada') RETURNING id`)
  ).rows[0]!.id;
  const user = await newUser();
  await db.query('INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)', [
    user.userId,
    tenant,
    role,
  ]);
  return { tenant, token: user.accessToken, userId: user.userId };
}

const current = (token: string, tenant?: string) => {
  const req = http().get(CURRENT).set('Authorization', bearer(token));
  return tenant === undefined ? req : req.set(TENANT_HEADER, tenant);
};

it('una sola membresía no necesita cabecera', async () => {
  const user = await newUser();
  const tenant = await createTenant(user.accessToken);
  const res = await current(user.accessToken).expect(200);
  expect(res.body).toMatchObject({ id: tenant, role: 'OWNER', status: 'ACTIVE' });
});

it('varias membresías exigen la cabecera', async () => {
  const user = await newUser();
  await createTenant(user.accessToken);
  const second = await createTenant(user.accessToken);
  const res = await current(user.accessToken).expect(400);
  expect(res.body).toMatchObject({
    errorCode: 'TENANT_REQUIRED',
    detail: 'El usuario pertenece a varios tenants; indique uno en la cabecera X-Tenant-Id',
  });
  const ok = await current(user.accessToken, second).expect(200);
  expect(ok.body.id).toBe(second);
});

it('sin empresa es 403', async () => {
  const res = await current((await newUser()).accessToken).expect(403);
  expect(res.body).toMatchObject({
    errorCode: 'TENANT_FORBIDDEN',
    detail: 'El usuario no pertenece a ningún tenant activo',
  });
});

it('una cabecera mal formada es 400', async () => {
  const user = await newUser();
  await createTenant(user.accessToken);
  const res = await current(user.accessToken, 'abc').expect(400);
  expect(res.body).toMatchObject({
    errorCode: 'TENANT_HEADER_INVALID',
    detail: 'La cabecera X-Tenant-Id debe ser un UUID',
  });
});

it('la cabecera en blanco cuenta como ausente', async () => {
  const user = await newUser();
  const tenant = await createTenant(user.accessToken);
  const res = await current(user.accessToken, '   ').expect(200);
  expect(res.body.id).toBe(tenant);
});

it('la cabecera se acepta en mayúsculas y con espacios', async () => {
  const user = await newUser();
  const tenant = await createTenant(user.accessToken);
  await current(user.accessToken, ` ${tenant.toUpperCase()} `).expect(200);
});

it('una empresa ajena y una inexistente responden igual', async () => {
  const user = await newUser();
  await createTenant(user.accessToken);
  const foreign = await createTenant((await newUser()).accessToken);
  const a = await current(user.accessToken, foreign).expect(403);
  const b = await current(user.accessToken, randomUUID()).expect(403);
  expect(a.body.errorCode).toBe('TENANT_FORBIDDEN');
  expect(a.body.detail).toBe('Sin acceso al tenant indicado');
  for (const field of ['errorCode', 'detail', 'title', 'status']) {
    expect(a.body[field]).toEqual(b.body[field]);
  }
});

it('la cabecera de una empresa ajena no da acceso (aunque tenga una propia)', async () => {
  const own = await newUser();
  await createTenant(own.accessToken);
  const foreign = await createTenant((await newUser()).accessToken);
  const res = await current(own.accessToken, foreign).expect(403);
  expect(res.body.errorCode).toBe('TENANT_FORBIDDEN');
});

it('una membresía suspendida da 403', async () => {
  const m = await member('ADMIN');
  await current(m.token).expect(200);
  await db.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1`, [m.tenant]);
  await current(m.token).expect(403);
  const res = await current(m.token, m.tenant).expect(403);
  expect(res.body.errorCode).toBe('TENANT_FORBIDDEN');
});

it('una empresa suspendida da 403', async () => {
  const user = await newUser();
  const tenant = await createTenant(user.accessToken);
  await db.query(`UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1`, [tenant]);
  await current(user.accessToken).expect(403);
  const res = await current(user.accessToken, tenant).expect(403);
  expect(res.body.errorCode).toBe('TENANT_FORBIDDEN');
});

it('el rol sale de la membresía', async () => {
  const m = await member('AUDITOR');
  const res = await current(m.token).expect(200);
  expect(res.body.role).toBe('AUDITOR');
});

describe('token firmado con datos que no son UUID', () => {
  async function token(sub: string, sid: string): Promise<string> {
    return (await new AccessTokens(testConfig.auth).issue(sub, sid, 'x@example.test', true)).value;
  }

  it('un sub o un sid inválido da 401, no 500', async () => {
    for (const [sub, sid] of [
      ['no-es-uuid', randomUUID()],
      [randomUUID(), 'no-es-uuid'],
      ["'; DROP TABLE users;--", randomUUID()],
    ] as const) {
      const res = await current(await token(sub, sid)).expect(401);
      expect(res.body.errorCode).toBe('UNAUTHENTICATED');
    }
  });

  it('un usuario que no existe da 401', async () => {
    const res = await current(await token(randomUUID(), randomUUID())).expect(401);
    expect(res.body.errorCode).toBe('UNAUTHENTICATED');
  });
});

it('sin credenciales es 401', async () => {
  await http().get(CURRENT).expect(401);
});

describe('API keys', () => {
  async function keyScenario() {
    const owner = await newUser();
    const tenant = await createTenant(owner.accessToken);
    const generated = generateApiKey();
    const row = await db.query<{ id: string }>(
      `INSERT INTO api_keys (tenant_id, created_by, name, public_id, secret_hash)
       VALUES ($1, $2, 'ERP', $3, $4) RETURNING id`,
      [tenant, owner.userId, generated.publicId, generated.secretHash],
    );
    return { tenant, owner, key: generated.value, keyId: row.rows[0]!.id };
  }
  const withKey = (key: string, tenant?: string) => {
    const req = http().get(CURRENT).set('X-Api-Key', key);
    return tenant === undefined ? req : req.set(TENANT_HEADER, tenant);
  };
  const expectUnauthenticated = async (req: ReturnType<typeof withKey>) => {
    const res = await req.expect(401);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.body).toMatchObject({ errorCode: 'UNAUTHENTICATED', detail: UNAUTHENTICATED });
  };

  it('la key actúa en su empresa como BILLER', async () => {
    const s = await keyScenario();
    const res = await withKey(s.key).expect(200);
    expect(res.body).toMatchObject({ id: s.tenant, role: 'BILLER' });
  });

  it('la cabecera de otra empresa es 403; la propia, 200; mal formada, 400', async () => {
    const s = await keyScenario();
    const other = await createTenant((await newUser()).accessToken);
    const res = await withKey(s.key, other).expect(403);
    expect(res.body).toMatchObject({ errorCode: 'TENANT_FORBIDDEN', detail: 'Sin acceso al tenant indicado' });
    const ok = await withKey(s.key, s.tenant.toUpperCase()).expect(200);
    expect(ok.body.id).toBe(s.tenant);
    const bad = await withKey(s.key, 'no-es-un-uuid').expect(400);
    expect(bad.body.errorCode).toBe('TENANT_HEADER_INVALID');
    await withKey(s.key, '  ').expect(200);
  });

  it('una empresa suspendida deshabilita la key', async () => {
    const s = await keyScenario();
    await db.query(`UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1`, [s.tenant]);
    await expectUnauthenticated(withKey(s.key));
  });

  it('un creador sin acceso deshabilita la key', async () => {
    const s = await keyScenario();
    await db.query(
      `UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`,
      [s.tenant, s.owner.userId],
    );
    await expectUnauthenticated(withKey(s.key));
  });

  it('un creador que ya no factura deshabilita la key', async () => {
    const s = await keyScenario();
    await db.query(`UPDATE memberships SET role = 'AUDITOR' WHERE tenant_id = $1 AND user_id = $2`, [
      s.tenant,
      s.owner.userId,
    ]);
    await expectUnauthenticated(withKey(s.key));
  });

  it('las rutas de persona rechazan la key con 403', async () => {
    const s = await keyScenario();
    for (const call of [
      () => http().post('/api/v1/tenants').send({ name: 'Otra' }),
      () => http().get('/api/v1/tenants'),
    ]) {
      const res = await call().set('X-Api-Key', s.key).expect(403);
      expect(res.body.errorCode).toBe('API_KEY_NOT_ALLOWED');
    }
  });
});
