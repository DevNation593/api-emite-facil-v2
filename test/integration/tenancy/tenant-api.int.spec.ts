import pg from 'pg';
import { startStack, type StackHandle } from '../../support/containers.js';
import { registerAndLogin, startTestApp, type TestApp } from '../../support/test-app.js';

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

async function newUserToken(): Promise<string> {
  return (await registerAndLogin(http())).accessToken;
}

async function createTenant(token: string, name = 'Empresa'): Promise<string> {
  const res = await http()
    .post('/api/v1/tenants')
    .set('Authorization', bearer(token))
    .send({ name })
    .expect(201);
  return (res.body as { id: string }).id;
}

it('crea la empresa con quien llama como propietario', async () => {
  const token = await newUserToken();
  const res = await http()
    .post('/api/v1/tenants')
    .set('Authorization', bearer(token))
    .send({ name: '  Comercial Andina  ' })
    .expect(201);
  expect(res.body).toEqual({
    id: expect.any(String),
    name: 'Comercial Andina',
    status: 'ACTIVE',
    role: 'OWNER',
  });
  const id = (res.body as { id: string }).id;
  const role = await db.query('SELECT role FROM memberships WHERE tenant_id = $1', [id]);
  expect(role.rows).toEqual([{ role: 'OWNER' }]);
  const audit = await db.query(
    `SELECT actor_id, api_key_id, metadata FROM audit_events
     WHERE action = 'TENANT_CREATED' AND entity_id = $1 AND tenant_id = $1 AND entity_type = 'TENANT'`,
    [id],
  );
  expect(audit.rows).toHaveLength(1);
  expect(audit.rows[0].api_key_id).toBeNull();
  expect(audit.rows[0].metadata).toEqual({ name: 'Comercial Andina' });
});

it('lista solo las empresas de quien llama, por nombre e id', async () => {
  const token = await newUserToken();
  const b = await createTenant(token, 'Beta');
  const a = await createTenant(token, 'Alfa');
  const foreign = await createTenant(await newUserToken());
  const res = await http().get('/api/v1/tenants').set('Authorization', bearer(token)).expect(200);
  expect((res.body as Array<{ id: string }>).map((t) => t.id)).toEqual([a, b]);
  expect(res.body).not.toContainEqual(expect.objectContaining({ id: foreign }));
  expect((res.body as Array<{ role: string }>)[0]!.role).toBe('OWNER');
});

it('no lista una empresa donde la membresía está suspendida', async () => {
  const token = await newUserToken();
  const id = await createTenant(token);
  await db.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE tenant_id = $1`, [id]);
  const res = await http().get('/api/v1/tenants').set('Authorization', bearer(token)).expect(200);
  expect(res.body).toEqual([]);
});

it('rechaza un nombre en blanco, demasiado largo o sin nombre', async () => {
  const token = await newUserToken();
  for (const name of ['', '   ', 'x'.repeat(201)]) {
    const res = await http()
      .post('/api/v1/tenants')
      .set('Authorization', bearer(token))
      .send({ name })
      .expect(400);
    expect(res.body).toMatchObject({
      errorCode: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ field: 'name' })],
    });
  }
  const res = await http()
    .post('/api/v1/tenants')
    .set('Authorization', bearer(token))
    .send({})
    .expect(400);
  expect(res.body.errorCode).toBe('VALIDATION_FAILED');
});

it('rechaza caracteres de control en el nombre', async () => {
  const token = await newUserToken();
  const res = await http()
    .post('/api/v1/tenants')
    .set('Authorization', bearer(token))
    .set('Content-Type', 'application/json')
    .send('{"name":"a\\u0000b"}')
    .expect(400);
  expect(res.body).toMatchObject({
    errorCode: 'VALIDATION_FAILED',
    errors: [expect.objectContaining({ field: 'name' })],
  });
});

it('rechaza un JSON mal formado', async () => {
  const token = await newUserToken();
  const res = await http()
    .post('/api/v1/tenants')
    .set('Authorization', bearer(token))
    .set('Content-Type', 'application/json')
    .send('{')
    .expect(400);
  expect(res.body.errorCode).toBe('MALFORMED_REQUEST');
});

it('ignora id y tenantId del cuerpo', async () => {
  const supplied = '99999999-9999-4999-8999-999999999999';
  const token = await newUserToken();
  const res = await http()
    .post('/api/v1/tenants')
    .set('Authorization', bearer(token))
    .send({ name: 'Acme', id: supplied, tenantId: supplied })
    .expect(201);
  expect((res.body as { id: string }).id).not.toBe(supplied);
  const rows = await db.query('SELECT 1 FROM tenants WHERE id = $1', [supplied]);
  expect(rows.rows).toHaveLength(0);
});

describe('auditoría en la misma transacción', () => {
  const FAILING_NAME = 'FALLA-AUDITORIA';

  beforeAll(async () => {
    // Solo para esta prueba: rechaza el evento de la empresa con ese nombre.
    await db.query(`
      CREATE FUNCTION test_fail_tenant_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.metadata->>'name' = '${FAILING_NAME}' THEN RAISE EXCEPTION 'auditoría provocada'; END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_tenant_audit BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_tenant_audit();
    `);
  });
  afterAll(async () => {
    await db.query('DROP TRIGGER test_fail_tenant_audit ON audit_events');
    await db.query('DROP FUNCTION test_fail_tenant_audit()');
  });

  it('si la auditoría falla no queda la empresa ni su membresía', async () => {
    const token = await newUserToken();
    const res = await http()
      .post('/api/v1/tenants')
      .set('Authorization', bearer(token))
      .send({ name: FAILING_NAME })
      .expect(500);
    expect(res.body.errorCode).toBe('INTERNAL_ERROR');
    const tenants = await db.query('SELECT 1 FROM tenants WHERE name = $1', [FAILING_NAME]);
    expect(tenants.rows).toHaveLength(0);
    const listed = await http().get('/api/v1/tenants').set('Authorization', bearer(token)).expect(200);
    expect(listed.body).toEqual([]);
  });
});
