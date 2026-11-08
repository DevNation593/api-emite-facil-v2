import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AuditLog } from '../../../src/compliance/audit-log.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  bearer,
  createTaxpayer,
  memberToken,
  newOwner,
  randomRuc,
  taxpayerJson,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de TaxpayerApiIT.
const TAXPAYERS = '/api/v1/taxpayers';
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
const post = (token: string, body: unknown) =>
  http().post(TAXPAYERS).set('Authorization', bearer(token)).send(body as object);
const count = async (text: string, params: unknown[]) =>
  Number((await db.query<{ n: string }>(text, params)).rows[0]!.n);

it('el propietario da de alta un emisor', async () => {
  const { token, tenant } = await newOwner(http());
  const ruc = randomRuc();
  const res = await post(token, taxpayerJson(ruc)).expect(201);
  expect(res.body).toEqual({
    id: expect.any(String),
    ruc,
    legalName: 'Comercial Andina S.A.',
    tradeName: 'Andina',
    headOfficeAddress: 'Av. Amazonas N34-12, Quito',
    phone: null,
    defaultEnvironment: '1',
    accountingRequired: false,
    specialTaxpayerCode: null,
    withholdingAgentCode: null,
    rimpeRegime: 'NONE',
    productionEnabledAt: null,
  });
  // El orden de las propiedades es el del record TaxpayerResponse.
  expect(Object.keys(res.body)).toEqual([
    'id',
    'ruc',
    'legalName',
    'tradeName',
    'headOfficeAddress',
    'phone',
    'defaultEnvironment',
    'accountingRequired',
    'specialTaxpayerCode',
    'withholdingAgentCode',
    'rimpeRegime',
    'productionEnabledAt',
  ]);
  const id = (res.body as { id: string }).id;
  const one = await http().get(`${TAXPAYERS}/${id}`).set('Authorization', bearer(token)).expect(200);
  expect(one.body).toEqual(res.body);
  const list = await http().get(TAXPAYERS).set('Authorization', bearer(token)).expect(200);
  expect((list.body as Array<{ id: string }>).map((t) => t.id)).toContain(id);
  expect((await db.query('SELECT tenant_id FROM taxpayers WHERE id = $1', [id])).rows[0].tenant_id).toBe(tenant);
  expect(
    await count(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'TAXPAYER_CREATED' AND entity_id = $1 AND tenant_id = $2",
      [id, tenant],
    ),
  ).toBe(1);
  const metadata = (
    await db.query("SELECT metadata FROM audit_events WHERE action = 'TAXPAYER_CREATED' AND entity_id = $1", [id])
  ).rows[0].metadata;
  expect(metadata).toEqual({ ruc });
});

it('el teléfono se da al alta y se cambia después', async () => {
  const { token: owner, tenant } = await newOwner(http());
  const created = await post(owner, { ...taxpayerJson(randomRuc()), phone: '022569442' }).expect(201);
  expect(created.body.phone).toBe('022569442');
  const id = (created.body as { id: string }).id;
  const patch = (token: string, body: unknown) =>
    http().patch(`${TAXPAYERS}/${id}`).set('Authorization', bearer(token)).send(body as object);

  const changed = await patch(owner, { phone: ' +593 2 256 9442 ' }).expect(200);
  expect(changed.body.phone).toBe('+593 2 256 9442');
  expect(changed.body.ruc).toBeDefined();
  const read = await http().get(`${TAXPAYERS}/${id}`).set('Authorization', bearer(owner)).expect(200);
  expect(read.body.phone).toBe('+593 2 256 9442');
  const cleared = await patch(owner, { phone: '  ' }).expect(200);
  expect(cleared.body.phone).toBeNull();
  expect(
    await count(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'TAXPAYER_UPDATED' AND entity_id = $1 AND tenant_id = $2",
      [id, tenant],
    ),
  ).toBe(2);
  const forbidden = await patch(await memberToken(http(), db, tenant, 'BILLER'), { phone: '1' }).expect(403);
  expect(forbidden.body.errorCode).toBe('ROLE_FORBIDDEN');
  await patch(owner, { phone: '9'.repeat(31) }).expect(400);
  await http()
    .patch(`${TAXPAYERS}/${randomUUID()}`)
    .set('Authorization', bearer(owner))
    .send({ phone: '1' })
    .expect(404);
});

it('facturador y auditor leen pero no dan de alta; el administrador sí', async () => {
  const { token: owner, tenant } = await newOwner(http());
  await createTaxpayer(http(), owner);
  for (const role of ['BILLER', 'AUDITOR']) {
    const member = await memberToken(http(), db, tenant, role);
    const res = await post(member, taxpayerJson(randomRuc())).expect(403);
    expect(res.body.errorCode).toBe('ROLE_FORBIDDEN');
    const list = await http().get(TAXPAYERS).set('Authorization', bearer(member)).expect(200);
    expect(list.body).toHaveLength(1);
  }
  await post(await memberToken(http(), db, tenant, 'ADMIN'), taxpayerJson(randomRuc())).expect(201);
});

async function expectInvalid(token: string, body: Record<string, unknown>, field: string): Promise<void> {
  const res = await post(token, body).expect(400);
  expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  expect((res.body.errors as Array<{ field: string }>).map((e) => e.field)).toContain(field);
}

it('rechaza un cuerpo inválido sin dejar nada', async () => {
  const { token } = await newOwner(http());
  const valid = taxpayerJson(randomRuc());
  const ruc = valid.ruc as string;
  await expectInvalid(token, { ...valid, ruc: '179001234500' }, 'ruc');
  await expectInvalid(token, { ...valid, ruc: '17900123450AB' }, 'ruc');
  await expectInvalid(token, { ...valid, ruc: ` ${ruc.slice(1)}` }, 'ruc');
  await expectInvalid(token, { ...valid, defaultEnvironment: '3' }, 'defaultEnvironment');
  await expectInvalid(token, { ...valid, legalName: '' }, 'legalName');
  await expectInvalid(token, { ...valid, legalName: 'Comercial\u0000Andina' }, 'legalName');
  await expectInvalid(token, { ...valid, tradeName: 'An\u0007dina' }, 'tradeName');
  await expectInvalid(token, { ...valid, headOfficeAddress: '   ' }, 'headOfficeAddress');
  expect(await count('SELECT count(*) AS n FROM taxpayers WHERE ruc = $1', [ruc])).toBe(0);
});

it('el RUC termina en el 001 del establecimiento principal', async () => {
  const { token } = await newOwner(http());
  for (const ruc of ['1790012345002', '1790012345000', '1790012345010']) {
    await expectInvalid(token, taxpayerJson(ruc), 'ruc');
  }
  await post(token, taxpayerJson(randomRuc())).expect(201);
});

it('el mismo RUC en la misma empresa es conflicto', async () => {
  const { token } = await newOwner(http());
  const ruc = randomRuc();
  await createTaxpayer(http(), token, ruc);
  const res = await post(token, taxpayerJson(ruc)).expect(409);
  expect(res.body).toMatchObject({
    errorCode: 'RUC_ALREADY_REGISTERED',
    detail: 'El RUC ya está registrado en la plataforma',
  });
});

it('el mismo RUC en otra empresa es conflicto sin revelar de quién es', async () => {
  const a = await newOwner(http());
  const ruc = randomRuc();
  const taxpayerA = await createTaxpayer(http(), a.token, ruc);
  const b = await newOwner(http());
  const res = await post(b.token, taxpayerJson(ruc)).expect(409);
  expect(res.body.errorCode).toBe('RUC_ALREADY_REGISTERED');
  expect(res.text).not.toContain(a.tenant);
  expect(res.text).not.toContain(taxpayerA);
  expect(res.text).not.toContain('Empresa de prueba');
});

it('dos altas simultáneas del mismo RUC: una gana', async () => {
  const ruc = randomRuc();
  const a = await newOwner(http());
  const b = await newOwner(http());
  const statuses = await Promise.all([post(a.token, taxpayerJson(ruc)), post(b.token, taxpayerJson(ruc))]);
  expect(statuses.map((r) => r.status).sort((x, y) => x - y)).toEqual([201, 409]);
  expect(await count('SELECT count(*) AS n FROM taxpayers WHERE ruc = $1', [ruc])).toBe(1);
});

it('el RUC conserva el cero inicial', async () => {
  const { token } = await newOwner(http());
  const ruc = `0${randomRuc().slice(1)}`;
  const res = await post(token, taxpayerJson(ruc)).expect(201);
  expect(res.body.ruc).toBe(ruc);
});

it('un tenantId en el cuerpo se ignora', async () => {
  const a = await newOwner(http());
  const b = await newOwner(http());
  const res = await post(a.token, { ...taxpayerJson(randomRuc()), tenantId: b.tenant }).expect(201);
  const row = await db.query('SELECT tenant_id FROM taxpayers WHERE id = $1', [(res.body as { id: string }).id]);
  expect(row.rows[0].tenant_id).toBe(a.tenant);
});

it('si la auditoría falla, el emisor no queda creado', async () => {
  const { token } = await newOwner(http());
  const ruc = randomRuc();
  const spy = vi.spyOn(AuditLog.prototype, 'recordFor').mockRejectedValueOnce(new Error('auditoría caída'));
  try {
    await post(token, taxpayerJson(ruc)).expect(500);
  } finally {
    spy.mockRestore();
  }
  expect(await count('SELECT count(*) AS n FROM taxpayers WHERE ruc = $1', [ruc])).toBe(0);
});
