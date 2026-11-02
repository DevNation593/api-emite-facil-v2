import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startStack, type StackHandle } from '../../support/containers.js';
import { bearer, createEstablishment, createTaxpayer, memberToken, newOwner } from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de EmissionPointApiIT.
const POINTS = '/api/v1/emission-points';
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let owner: string;
let tenant: string;
let taxpayer: string;
let establishment: string;

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
  establishment = await createEstablishment(testApp.http, owner, taxpayer, '001');
});

const http = () => testApp.http;
const post = (token: string, payload: unknown) =>
  http().post(POINTS).set('Authorization', bearer(token)).send(payload as object);
const list = (token: string, establishmentId: string) =>
  http().get(POINTS).query({ establishmentId }).set('Authorization', bearer(token));

it('crea y lista puntos de emisión', async () => {
  const res = await post(owner, { establishmentId: establishment, code: '002' }).expect(201);
  expect(res.body).toEqual({ id: expect.any(String), establishmentId: establishment, code: '002', enabled: true });
  expect(Object.keys(res.body)).toEqual(['id', 'establishmentId', 'code', 'enabled']);
  const created = (res.body as { id: string }).id;
  await post(owner, { establishmentId: establishment, code: '001' }).expect(201);
  const points = await list(owner, establishment).expect(200);
  expect((points.body as Array<{ code: string }>).map((p) => p.code)).toEqual(['001', '002']);
  const audit = await db.query(
    "SELECT metadata FROM audit_events WHERE action = 'EMISSION_POINT_CREATED' AND entity_id = $1 AND tenant_id = $2",
    [created, tenant],
  );
  expect(audit.rows).toEqual([{ metadata: { establishmentId: establishment, code: '002' } }]);
});

it('un código repetido es conflicto', async () => {
  await post(owner, { establishmentId: establishment, code: '001' }).expect(201);
  const res = await post(owner, { establishmentId: establishment, code: '001' }).expect(409);
  expect(res.body).toMatchObject({
    errorCode: 'EMISSION_POINT_CODE_TAKEN',
    detail: 'El establecimiento ya tiene un punto de emisión con ese código',
  });
});

it('el mismo código en otro establecimiento se admite', async () => {
  const other = await createEstablishment(http(), owner, taxpayer, '002');
  await post(owner, { establishmentId: establishment, code: '001' }).expect(201);
  await post(owner, { establishmentId: other, code: '001' }).expect(201);
});

it('rechaza un código inválido o la falta del establecimiento', async () => {
  for (const code of ['1', '0001', 'A01', '']) {
    const res = await post(owner, { establishmentId: establishment, code }).expect(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
    expect(res.body.errors[0].field).toBe('code');
  }
  const res = await post(owner, { code: '001' }).expect(400);
  expect(res.body.errors[0].field).toBe('establishmentId');
});

it('un rol de solo lectura no crea, pero lista', async () => {
  const auditor = await memberToken(http(), db, tenant, 'AUDITOR');
  const res = await post(auditor, { establishmentId: establishment, code: '001' }).expect(403);
  expect(res.body.errorCode).toBe('ROLE_FORBIDDEN');
  await list(auditor, establishment).expect(200);
});

it('sin establishmentId es petición mal formada; uno desconocido, 404', async () => {
  const res = await http().get(POINTS).set('Authorization', bearer(owner)).expect(400);
  expect(res.body.errorCode).toBe('MALFORMED_REQUEST');
  await list(owner, randomUUID()).expect(404);
});
