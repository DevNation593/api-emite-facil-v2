import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startStack, type StackHandle } from '../../support/containers.js';
import { bearer, createEstablishment, createTaxpayer, memberToken, newOwner } from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de EstablishmentApiIT.
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let owner: string;
let tenant: string;
let taxpayer: string;

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
beforeEach(async () => {
  ({ token: owner, tenant } = await newOwner(testApp.http));
  taxpayer = await createTaxpayer(testApp.http, owner);
});

const http = () => testApp.http;
const path = (taxpayerId: string) => `/api/v1/taxpayers/${taxpayerId}/establishments`;
const body = (code: string) => ({ code, address: 'Av. 10 de Agosto, Quito' });
const post = (token: string, taxpayerId: string, payload: unknown) =>
  http().post(path(taxpayerId)).set('Authorization', bearer(token)).send(payload as object);

it('crea y lista establecimientos', async () => {
  const res = await post(owner, taxpayer, { code: '002', address: '  Av. 10 de Agosto, Quito  ' }).expect(201);
  expect(res.body).toEqual({ id: expect.any(String), taxpayerId: taxpayer, code: '002', address: 'Av. 10 de Agosto, Quito' });
  expect(Object.keys(res.body)).toEqual(['id', 'taxpayerId', 'code', 'address']);
  const first = await createEstablishment(http(), owner, taxpayer, '001');
  const list = await http().get(path(taxpayer)).set('Authorization', bearer(owner)).expect(200);
  expect((list.body as Array<{ code: string }>).map((e) => e.code)).toEqual(['001', '002']);
  const audit = await db.query(
    "SELECT metadata FROM audit_events WHERE action = 'ESTABLISHMENT_CREATED' AND entity_id = $1 AND tenant_id = $2",
    [first, tenant],
  );
  expect(audit.rows).toEqual([{ metadata: { taxpayerId: taxpayer, code: '001' } }]);
});

it('un código repetido es conflicto', async () => {
  await createEstablishment(http(), owner, taxpayer, '001');
  const res = await post(owner, taxpayer, body('001')).expect(409);
  expect(res.body).toMatchObject({
    errorCode: 'ESTABLISHMENT_CODE_TAKEN',
    detail: 'El emisor ya tiene un establecimiento con ese código',
  });
});

it('el mismo código en otro emisor se admite', async () => {
  await createEstablishment(http(), owner, taxpayer, '001');
  const other = await createTaxpayer(http(), owner);
  await post(owner, other, body('001')).expect(201);
});

it('rechaza un código o una dirección inválidos', async () => {
  for (const code of ['1', '0001', 'A01', '']) {
    const res = await post(owner, taxpayer, body(code)).expect(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
    expect(res.body.errors[0].field).toBe('code');
  }
  for (const address of ['Quito\u0000Norte', ' ']) {
    const res = await post(owner, taxpayer, { code: '001', address }).expect(400);
    expect(res.body.errors[0].field).toBe('address');
  }
});

it('un rol de solo lectura no crea, pero lista', async () => {
  await createEstablishment(http(), owner, taxpayer, '001');
  const biller = await memberToken(http(), db, tenant, 'BILLER');
  const res = await post(biller, taxpayer, body('002')).expect(403);
  expect(res.body.errorCode).toBe('ROLE_FORBIDDEN');
  const list = await http().get(path(taxpayer)).set('Authorization', bearer(biller)).expect(200);
  expect(list.body).toHaveLength(1);
});

it('un emisor desconocido no existe y un id mal formado es petición mal formada', async () => {
  const unknown = randomUUID();
  const res = await post(owner, unknown, body('001')).expect(404);
  expect(res.body.errorCode).toBe('NOT_FOUND');
  await http().get(path(unknown)).set('Authorization', bearer(owner)).expect(404);
  const malformed = await http()
    .get('/api/v1/taxpayers/no-es-uuid/establishments')
    .set('Authorization', bearer(owner))
    .expect(400);
  expect(malformed.body.errorCode).toBe('MALFORMED_REQUEST');
});
