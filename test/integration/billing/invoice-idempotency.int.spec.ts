import pg from 'pg';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  type BillingScenario,
  billingScenario,
  invoiceJson,
  invoiceRequest,
  memberToken,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de InvoiceIdempotencyIT, más los casos de huella de e3.json.
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let s: BillingScenario;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack, { EINVOICE_RATE_LIMIT_WRITES: '1000000' });
  // Escuchando de antemano: si no, supertest abre un puerto por petición simultánea.
  await testApp.app.listen(0, '127.0.0.1');
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});
beforeEach(async () => {
  s = await billingScenario(testApp.http, db);
});

const http = () => testApp.http;
const send = (token: string, key: string, body: unknown) => invoiceRequest(http(), token, body, key);

async function acceptedId(call: ReturnType<typeof send>): Promise<string> {
  const res = await call;
  expect(res.status, res.text).toBe(202);
  return (res.body as { id: string }).id;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);
}
const documentCount = (tenant: string) =>
  count('SELECT count(*) AS n FROM fiscal_documents WHERE tenant_id = $1', tenant);
const nextValue = () => count('SELECT next_value AS n FROM document_sequences WHERE emission_point_id = $1', s.point);

it('la misma clave y el mismo cuerpo devuelven el mismo comprobante', async () => {
  const body = invoiceJson(s, '1', '11.50');
  const first = await acceptedId(send(s.owner, 'retry-1', body));
  const second = await send(s.owner, 'retry-1', body).expect(202);
  expect(second.body).toEqual({ id: first, state: 'RESERVED', statusUrl: `/api/v1/documents/${first}` });
  expect(await documentCount(s.tenant)).toBe(1);
  expect(await nextValue()).toBe(2);
  expect(await count('SELECT count(*) AS n FROM outbox_events WHERE tenant_id = $1', s.tenant)).toBe(1);
});

it('el JSON reordenado es la misma petición', async () => {
  const body = invoiceJson(s, '1', '11.50');
  const reordered =
    `{ "payments": [ {"amount":"11.50", "methodCode":"20"} ],\n  "lines":[{"quantity":"1","productId":"${s.product}"}],` +
    ` "customerId":"${s.customer}", "emissionPointCode":"001", "establishmentCode":"001", "taxpayerId":"${s.taxpayer}" }`;
  const first = await acceptedId(send(s.owner, 'retry-2', body));
  expect(await acceptedId(send(s.owner, 'retry-2', reordered))).toBe(first);
  expect(await documentCount(s.tenant)).toBe(1);
});

it('la misma clave con otro cuerpo es un conflicto', async () => {
  await acceptedId(send(s.owner, 'retry-3', invoiceJson(s, '1', '11.50')));
  const res = await send(s.owner, 'retry-3', invoiceJson(s, '2', '23.00')).expect(409);
  expect(res.body).toMatchObject({
    errorCode: 'IDEMPOTENCY_KEY_REUSED',
    detail: 'La clave de idempotencia ya se usó con una petición distinta',
  });
  expect(await documentCount(s.tenant)).toBe(1);
  expect(await nextValue()).toBe(2);
});

it('la misma clave en otra empresa es independiente', async () => {
  const other = await billingScenario(http(), db);
  const first = await acceptedId(send(s.owner, 'shared-key', invoiceJson(s, '1', '11.50')));
  const second = await acceptedId(send(other.owner, 'shared-key', invoiceJson(other, '1', '11.50')));
  expect(second).not.toBe(first);
  expect(await documentCount(s.tenant)).toBe(1);
  expect(await documentCount(other.tenant)).toBe(1);
});

it('la misma clave de otro miembro de la empresa es la misma petición', async () => {
  const body = invoiceJson(s, '1', '11.50');
  const first = await acceptedId(send(s.owner, 'retry-4', body));
  expect(await acceptedId(send(await memberToken(http(), db, s.tenant, 'BILLER'), 'retry-4', body))).toBe(first);
  await send(await memberToken(http(), db, s.tenant, 'AUDITOR'), 'retry-4', body).expect(403);
});

it('una petición fallida no gasta la clave', async () => {
  await send(s.owner, 'retry-5', invoiceJson(s, '1', '99.99')).expect(422);
  expect(await count('SELECT count(*) AS n FROM idempotency_records WHERE tenant_id = $1', s.tenant)).toBe(0);
  await acceptedId(send(s.owner, 'retry-5', invoiceJson(s, '1', '11.50')));
  expect(await documentCount(s.tenant)).toBe(1);
  expect(await nextValue()).toBe(2);
});

it('peticiones simultáneas con la misma clave crean un solo comprobante', async () => {
  const threads = 8;
  const rounds = 10;
  const body = invoiceJson(s, '1', '11.50');
  for (let round = 0; round < rounds; round++) {
    const ids = await Promise.all(
      Array.from({ length: threads }, () => acceptedId(send(s.owner, `race-${round}`, body))),
    );
    expect(new Set(ids).size, `ronda ${round}`).toBe(1);
  }
  expect(await documentCount(s.tenant)).toBe(rounds);
  expect(await nextValue()).toBe(rounds + 1);
  const sequences = await db.query<{ sequence: number }>(
    'SELECT sequence FROM fiscal_documents WHERE tenant_id = $1 ORDER BY sequence',
    [s.tenant],
  );
  expect(sequences.rows.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

describe('huella de la petición, como e3.json', () => {
  const asText = (body: unknown, from: string, to: string) => JSON.stringify(body).replace(from, to);

  it('"quantity": 2 y "2" son la misma petición', async () => {
    const body = invoiceJson(s, '2', '23.00');
    const first = await acceptedId(send(s.owner, 'hash-1', body));
    expect(await acceptedId(send(s.owner, 'hash-1', asText(body, '"quantity":"2"', '"quantity":2')))).toBe(first);
    const decimal = await send(s.owner, 'hash-1', asText(body, '"quantity":"2"', '"quantity":"2.0"')).expect(409);
    expect(decimal.body.errorCode).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('2.50 como número y "2.50" son la misma petición; "2.5" no', async () => {
    const text = asText(invoiceJson(s, '2', '28.75'), '"quantity":"2"', '"quantity":2.50');
    const first = await acceptedId(send(s.owner, 'hash-2', text));
    expect(await acceptedId(send(s.owner, 'hash-2', invoiceJson(s, '2.50', '28.75')))).toBe(first);
    await send(s.owner, 'hash-2', invoiceJson(s, '2.5', '28.75')).expect(409);
  });

  it('una clave con espacios alrededor es la misma clave', async () => {
    const body = invoiceJson(s, '1', '11.50');
    const first = await acceptedId(send(s.owner, 'espacios', body));
    expect(await acceptedId(send(s.owner, ' espacios ', body))).toBe(first);
  });
});
