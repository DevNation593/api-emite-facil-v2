import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  bearer,
  type BillingScenario,
  billingScenario,
  createEmissionPoint,
  createEstablishment,
  createTaxpayer,
  invoiceJson,
  invoiceRequest,
  issueInvoice,
  setState,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

/*
 * Traducción de InvoiceReissueIT. Un comprobante que el SRI devolvió o no autorizó no se corrige: se
 * emite otro que lo reemplaza, con su propio número y su propia clave, y ambos quedan enlazados. En E3
 * no hay worker ni SRI: el estado del rechazado se pone por SQL. Las comprobaciones de artefactos
 * (document_artifacts del rechazado sin cambios) de aRejectedDocumentIsReplacedByANewOneAndBothSayIt
 * se añaden en E4, cuando existan.
 */
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

async function accessKey(document: string): Promise<string> {
  return (await db.query<{ access_key: string }>('SELECT access_key FROM fiscal_documents WHERE id = $1', [document]))
    .rows[0]!.access_key;
}

/** Una factura emitida y puesta en ese estado. */
async function rejected(state: string): Promise<string> {
  const document = await issueInvoice(http(), s.owner, invoiceJson(s, '2', '23.00'));
  await setState(db, document, state);
  return document;
}

const replacing = (replaced: string, scenario: BillingScenario = s) => ({
  ...invoiceJson(scenario, '2', '23.00'),
  replacesDocumentId: replaced,
});

const reissue = (body: unknown, key: string = randomUUID(), token: string = s.owner) =>
  invoiceRequest(http(), token, body, key);

const detail = (id: string, token: string = s.owner) =>
  http().get(`/api/v1/documents/${id}`).set('Authorization', bearer(token));

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);
}
const documentCount = () => count('SELECT count(*) AS n FROM fiscal_documents WHERE tenant_id = $1', s.tenant);

it.each(['RETURNED', 'NOT_AUTHORIZED'])('un comprobante %s se reemplaza por uno nuevo y ambos lo dicen', async (state) => {
  const replaced = await rejected(state);
  const oldKey = await accessKey(replaced);

  const res = await reissue(replacing(replaced)).expect(202);
  const replacement = (res.body as { id: string }).id;

  // Uno nuevo de verdad: otro secuencial y otra clave.
  expect(replacement).not.toBe(replaced);
  expect(await accessKey(replacement)).not.toBe(oldKey);
  const fresh = (await detail(replacement).expect(200)).body as Record<string, unknown>;
  expect(fresh).toMatchObject({ replacesDocumentId: replaced, replacedByDocumentId: null });
  const old = (await detail(replaced).expect(200)).body as Record<string, unknown>;
  expect(old).toMatchObject({ replacedByDocumentId: replacement, replacesDocumentId: null, state });
  // El rechazado no se toca.
  expect(await accessKey(replaced)).toBe(oldKey);
  // E4: aquí se comprueba que document_artifacts del rechazado quedó igual.
  const audit = await db.query<{ metadata: unknown }>(
    "SELECT metadata FROM audit_events WHERE action = 'DOCUMENT_REPLACED' AND entity_id = $1",
    [replaced],
  );
  expect(audit.rows).toEqual([{ metadata: { replacedBy: replacement } }]);
});

it('un comprobante cuyo XML no se pudo generar también se reemplaza', async () => {
  const broken = await rejected('XSD_INVALID');
  const res = await reissue(replacing(broken)).expect(202);
  expect((await detail(broken).expect(200)).body).toMatchObject({
    replacedByDocumentId: (res.body as { id: string }).id,
  });
});

it('el reemplazo es del mismo emisor', async () => {
  const replaced = await rejected('RETURNED');
  const otherIssuer = await createTaxpayer(http(), s.owner);
  await createEmissionPoint(http(), s.owner, await createEstablishment(http(), s.owner, otherIssuer, '001'), '001');

  const res = await reissue({ ...replacing(replaced), taxpayerId: otherIssuer }).expect(409);
  expect(res.body).toMatchObject({
    errorCode: 'REPLACED_DOCUMENT_OTHER_ISSUER',
    detail: 'El comprobante que se reemplaza es de otro emisor de la empresa',
  });

  // El enlace es único y no se deshace: no se gasta en un comprobante de otro RUC.
  await reissue(replacing(replaced)).expect(202);
});

it('el detalle lleva lo que una reemisión necesita', async () => {
  const document = await rejected('RETURNED');
  const view = (await detail(document).expect(200)).body as { lines: { productId: string }[] };
  expect(view).toMatchObject({ customerId: s.customer, replacesDocumentId: null, replacedByDocumentId: null });
  expect(view.lines[0]!.productId).toBe(s.product);
});

it('solo se reemplazan comprobantes rechazados', async () => {
  const reserved = await issueInvoice(http(), s.owner, invoiceJson(s, '2', '23.00'));
  const authorized = await rejected('AUTHORIZED');
  const before = await documentCount();

  for (const notRejected of [reserved, authorized]) {
    const res = await reissue(replacing(notRejected)).expect(409);
    expect(res.body).toMatchObject({
      errorCode: 'REPLACED_DOCUMENT_NOT_REJECTED',
      detail: 'Solo se reemplaza un comprobante devuelto o no autorizado por el SRI, o cuyo XML no se pudo generar',
    });
  }
  await reissue(replacing(randomUUID())).expect(404);

  // Nada se emitió ni se gastó un secuencial.
  expect(await documentCount()).toBe(before);
  expect(await count('SELECT next_value AS n FROM document_sequences WHERE emission_point_id = $1', s.point)).toBe(3);
});

it('un comprobante se reemplaza una sola vez', async () => {
  const replaced = await rejected('RETURNED');
  const key = randomUUID();
  const first = await reissue(replacing(replaced), key).expect(202);

  // Repetir la misma petición devuelve la misma factura; otra petición distinta, no.
  const again = await reissue(replacing(replaced), key).expect(202);
  expect((again.body as { id: string }).id).toBe((first.body as { id: string }).id);
  const other = await reissue(replacing(replaced)).expect(409);
  expect(other.body).toMatchObject({
    errorCode: 'DOCUMENT_ALREADY_REPLACED',
    detail: 'Ese comprobante ya fue reemplazado por otro',
  });
});

it('dos reemisiones simultáneas del mismo comprobante dejan una sola', async () => {
  const replaced = await rejected('NOT_AUTHORIZED');
  const before = await documentCount();

  const results = await Promise.all(
    Array.from({ length: 4 }, () => reissue(replacing(replaced)).then((r) => ({ status: r.status, body: r.body }))),
  );

  expect(results.filter((r) => r.status === 202)).toHaveLength(1);
  const rest = results.filter((r) => r.status !== 202);
  expect(rest).toHaveLength(3);
  for (const r of rest) {
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ errorCode: 'DOCUMENT_ALREADY_REPLACED' });
  }
  expect(await documentCount()).toBe(before + 1);
  expect(
    await count('SELECT count(*) AS n FROM fiscal_documents WHERE replaces_document_id = $1', replaced),
  ).toBe(1);
  expect(
    await count("SELECT count(*) AS n FROM audit_events WHERE action = 'DOCUMENT_REPLACED' AND entity_id = $1", replaced),
  ).toBe(1);
});

it('el comprobante de otra empresa no se puede reemplazar', async () => {
  const replaced = await rejected('RETURNED');
  const other = await billingScenario(http(), db);

  await reissue(replacing(replaced, other), randomUUID(), other.owner).expect(404);
  expect((await detail(replaced).expect(200)).body).toMatchObject({ replacedByDocumentId: null });
  expect(
    await count("SELECT count(*) AS n FROM audit_events WHERE action = 'DOCUMENT_REPLACED' AND entity_id = $1", replaced),
  ).toBe(0);
});

describe('como e3.json', () => {
  it('replacesDocumentId nulo y vacío no reemplazan nada', async () => {
    await reissue({ ...invoiceJson(s, '1', '11.50'), replacesDocumentId: null }).expect(202);
    await reissue({ ...invoiceJson(s, '1', '11.50'), replacesDocumentId: '' }).expect(202);
  });

  it('un id desconocido es 404 y uno en mayúsculas es el mismo comprobante', async () => {
    await reissue({ ...invoiceJson(s, '1', '11.50'), replacesDocumentId: '00000000-0000-4000-8000-000000000000' })
      .expect(404)
      .expect((r) => expect(r.body).toMatchObject({ errorCode: 'NOT_FOUND', detail: 'Recurso no encontrado' }));
    const reserved = await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
    for (const id of [reserved, reserved.toUpperCase()]) {
      await reissue({ ...invoiceJson(s, '1', '11.50'), replacesDocumentId: id })
        .expect(409)
        .expect((r) => expect(r.body).toMatchObject({ errorCode: 'REPLACED_DOCUMENT_NOT_REJECTED' }));
    }
  });
});
