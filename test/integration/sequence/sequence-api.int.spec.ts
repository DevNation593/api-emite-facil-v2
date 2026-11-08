import { randomInt, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { SequenceService } from '../../../src/sequence/sequence.service.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  bearer,
  createEmissionPoint,
  createEstablishment,
  createTaxpayer,
  memberToken,
  newOwner,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de SequenceApiIT.
let stack: StackHandle;
let testApp: TestApp;
let pgc: pg.Client;
let owner: string;
let tenant: string;
let taxpayer: string;
let point: string;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
  pgc = new pg.Client({ connectionString: stack.databaseUrl });
  await pgc.connect();
}, 300_000);
afterAll(async () => {
  await pgc?.end();
  await testApp?.close();
  await stack?.stop();
});
beforeEach(async () => {
  ({ token: owner, tenant } = await newOwner(testApp.http));
  taxpayer = await createTaxpayer(testApp.http, owner);
  point = await createEmissionPoint(
    testApp.http,
    owner,
    await createEstablishment(testApp.http, owner, taxpayer, '001'),
    '001',
  );
});

const path = (emissionPoint: string) => `/api/v1/emission-points/${emissionPoint}/sequence`;
const put = (token: string, emissionPoint: string, body: unknown) =>
  testApp.http.put(path(emissionPoint)).set('Authorization', bearer(token)).send(body as object);
const body = (environment: string, documentType: string, nextValue: number) => ({
  environment,
  documentType,
  nextValue,
});

it('el propietario fija el secuencial inicial', async () => {
  const res = await put(owner, point, body('1', '01', 4521)).expect(200);
  expect(res.body).toEqual({ emissionPointId: point, environment: '1', documentType: '01', nextValue: 4521 });
  expect(Object.keys(res.body)).toEqual(['emissionPointId', 'environment', 'documentType', 'nextValue']);
  const db = testApp.app.get<Kysely<DB>>(DATABASE);
  const sequences = testApp.app.get(SequenceService);
  const reserved = await db
    .transaction()
    .execute((trx) => sequences.reserve(trx, tenant, point, '1', '01', '2026-10-10'));
  expect(reserved).toBe(4521);
  const audit = await pgc.query(
    "SELECT metadata FROM audit_events WHERE action = 'SEQUENCE_SET' AND entity_id = $1 AND tenant_id = $2",
    [point, tenant],
  );
  expect(audit.rows).toEqual([{ metadata: { environment: '1', documentType: '01', nextValue: 4521 } }]);
});

it('el secuencial se corrige antes del primer comprobante', async () => {
  await put(owner, point, body('1', '01', 10)).expect(200);
  expect((await put(owner, point, body('1', '01', 20)).expect(200)).body.nextValue).toBe(20);
});

it('un secuencial ya usado no se cambia', async () => {
  const customer = (
    await pgc.query(
      "INSERT INTO customers (tenant_id, id_type, id_number, name) VALUES ($1, '05', '1712345678', 'Cliente de prueba') RETURNING id",
      [tenant],
    )
  ).rows[0].id;
  const user = (
    await pgc.query('INSERT INTO users (email) VALUES ($1) RETURNING id', [`u-${randomUUID()}@example.test`])
  ).rows[0].id;
  const accessKey = Array.from({ length: 49 }, () => randomInt(10)).join('');
  await pgc.query(
    `INSERT INTO fiscal_documents (tenant_id, taxpayer_id, emission_point_id, customer_id, document_type,
       environment, issuer_ruc, establishment_code, emission_point_code, sequence, access_key, state,
       issue_date, currency, customer_id_type, customer_id_number, customer_name, subtotal, total_discount,
       total_tax, total, created_by, issuer_legal_name, issuer_head_office_address, establishment_address,
       issuer_accounting_required, issuer_rimpe_regime)
     VALUES ($1, $2, $3, $4, '01', '1', '1790012345001', '001', '001', 1, $5, 'RESERVED', DATE '2026-10-10',
       'USD', '05', '1712345678', 'Cliente de prueba', 10, 0, 1.5, 11.5, $6, 'Emisor de prueba', 'Quito',
       'Quito', false, 'NONE')`,
    [tenant, taxpayer, point, customer, accessKey, user],
  );
  const res = await put(owner, point, body('1', '01', 500)).expect(409);
  expect(res.body).toMatchObject({
    errorCode: 'SEQUENCE_ALREADY_USED',
    detail: 'El punto de emisión ya emitió comprobantes de este tipo; su secuencial no se puede cambiar',
  });
  await put(owner, point, body('2', '01', 500)).expect(200);
});

it('el facturador no fija el secuencial', async () => {
  const res = await put(await memberToken(testApp.http, pgc, tenant, 'BILLER'), point, body('1', '01', 10)).expect(
    403,
  );
  expect(res.body.errorCode).toBe('ROLE_FORBIDDEN');
});

it('rechaza valores fuera de rango y tipos desconocidos', async () => {
  for (const invalid of [
    body('1', '01', 0),
    body('1', '01', 1_000_000_000),
    body('1', '04', 5),
    body('3', '01', 5),
    { environment: '1', documentType: '01' },
  ]) {
    const res = await put(owner, point, invalid).expect(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  }
});

it('el punto de emisión de otra empresa no existe', async () => {
  const other = (await newOwner(testApp.http)).token;
  const res = await put(other, point, body('1', '01', 10)).expect(404);
  expect(res.body.errorCode).toBe('NOT_FOUND');
  await put(owner, randomUUID(), body('1', '01', 10)).expect(404);
  const rows = await pgc.query('SELECT count(*) AS n FROM document_sequences WHERE emission_point_id = $1', [point]);
  expect(Number(rows.rows[0].n)).toBe(0);
});
