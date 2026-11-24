import { randomUUID } from 'node:crypto';
import type { Test } from 'supertest';
import { DocumentArchiver } from '../../../src/delivery/document-archiver.js';
import { type AuthorizedInvoice, DeliveryHarness } from '../../support/delivery-scenario.js';
import { bearer, billingScenario, invoiceJson, issueInvoice, memberToken } from '../../support/scenario.js';
import { startTestApp } from '../../support/test-app.js';

// Traducción de delivery/DeliveryApiIT.java: consulta y reenvío de las entregas de un comprobante. El resto de las
// respuestas las fija el sondeo de Java (java-probes.int.spec.ts).
let h: DeliveryHarness;
let invoice: AuthorizedInvoice;

beforeAll(async () => {
  h = await DeliveryHarness.start();
}, 300_000);
afterAll(async () => {
  await h?.stop();
});
beforeEach(async () => {
  invoice = await h.authorizedInvoice();
});

const url = (document: string = invoice.document) => `/api/v1/documents/${document}/deliveries`;
const list = (token: string = invoice.s.owner, document?: string): Test =>
  h.http.get(url(document)).set('Authorization', bearer(token));
const request = (token: string = invoice.s.owner, body?: object, document?: string): Test => {
  const call = h.http.post(url(document)).set('Authorization', bearer(token));
  return body === undefined ? call : call.send(body);
};

const requestedEvents = async () =>
  (
    await h.db.query(
      `SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DELIVERY_REQUESTED'
       AND dispatched_at IS NULL`,
      [invoice.document],
    )
  ).rows;

it('deliveriesAreListedNewestFirst', async () => {
  await invoice.process();
  const other = `otra-${randomUUID()}@cliente.test`;
  await request(invoice.s.owner, { email: other }).expect(202);

  const res = await list().expect(200);

  const rows = res.body as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({
    id: expect.any(String),
    channel: 'EMAIL',
    recipient: other,
    status: 'PENDING',
    attemptCount: 0,
    lastError: null,
    createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3}|\.\d{6})?Z$/),
    sentAt: null,
    automatic: false,
  });
  expect(rows[1]).toMatchObject({
    channel: 'EMAIL',
    recipient: invoice.email,
    status: 'SENT',
    automatic: true,
    attemptCount: 1,
    createdAt: expect.any(String),
    sentAt: expect.any(String),
  });
});

it('resendToTheCustomerAddress', async () => {
  await invoice.process();

  const res = await request().expect(202);

  expect(res.body).toMatchObject({
    id: expect.any(String),
    recipient: invoice.email,
    status: 'PENDING',
    automatic: false,
  });
  expect(await invoice.rows()).toHaveLength(2);
  expect(await requestedEvents()).toEqual([{ payload: { documentId: invoice.document } }]);
  // La auditoría registra quién lo pidió y qué entrega es, no la dirección.
  const audit = await h.db.query<{ metadata: object }>(
    `SELECT metadata FROM audit_events WHERE entity_id = $1 AND tenant_id = $2 AND action = 'DELIVERY_REQUESTED'`,
    [invoice.document, invoice.s.tenant],
  );
  expect(audit.rows).toEqual([{ metadata: { deliveryId: (res.body as { id: string }).id } }]);

  // Lo que hará el worker al recibir el evento.
  expect(await invoice.process()).toBe(1);
  expect(h.smtp.raw(invoice.email)).toHaveLength(2);
});

it('resendToAnotherAddress', async () => {
  const other = `otra-${randomUUID()}@cliente.test`;

  const res = await request(invoice.s.owner, { email: other }).expect(202);
  expect(res.body).toMatchObject({ recipient: other });

  // Se envían la entrega automática al cliente y la pedida a la otra dirección.
  expect(await invoice.process()).toBe(2);
  expect(h.smtp.raw(other)).toHaveLength(1);
  expect(h.smtp.raw(invoice.email)).toHaveLength(1);
});

it('invalidAddressIsRejected', async () => {
  for (const email of [
    'no-es-un-correo',
    'a@b.test\r\nBcc: x@evil.test',
    'Nombre <a@b.test>',
    'a@b.test, c@d.test',
    'grupo:a@b.test,c@d.test;',
    `${'x'.repeat(250)}@b.test`,
  ]) {
    const res = await request(invoice.s.owner, { email });
    expect(res.status, email).toBe(400);
    expect(res.body).toMatchObject({ errorCode: 'MALFORMED_REQUEST' });
  }
  expect(await invoice.rows()).toEqual([]);
  expect(await requestedEvents()).toEqual([]);
});

it('documentWithoutAnyAddressNeedsOne', async () => {
  const other = await h.scenario(null);
  const document = await issueInvoice(h.http, other.owner, invoiceJson(other, '1', '11.50'));
  await h.pipeline.advance(other.tenant, document);

  const missing = await request(other.owner, undefined, document);
  expect(missing.status).toBe(422);
  expect(missing.body).toMatchObject({ errorCode: 'DELIVERY_RECIPIENT_MISSING' });
  await request(other.owner, { email: ' ' }, document).expect(422);

  await request(other.owner, { email: `nuevo-${randomUUID()}@cliente.test` }, document).expect(202);
});

it('notAuthorizedDocumentCannotBeDelivered', async () => {
  const { s } = invoice;
  const reserved = await issueInvoice(h.http, s.owner, invoiceJson(s, '1', '11.50'));

  const res = await request(s.owner, undefined, reserved);

  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ errorCode: 'DOCUMENT_NOT_AUTHORIZED' });
  expect((await h.db.query('SELECT 1 FROM deliveries WHERE document_id = $1', [reserved])).rowCount).toBe(0);
});

/** Inserta por SQL entregas pedidas por el usuario, como las que pudo dejar Java. */
const insertManual = (count: number) =>
  h.db.query(
    `INSERT INTO deliveries (tenant_id, document_id, channel, recipient, status, next_attempt_at, requested_by)
     SELECT tenant_id, id, 'EMAIL', customer_email, 'PENDING', now(), created_by
     FROM fiscal_documents, generate_series(1, $2::int) WHERE id = $1`,
    [invoice.document, count],
  );

const automaticCount = async () => (await invoice.rows()).filter((row) => row.requested_by === null).length;

// El tope por comprobante es 10, contando la entrega automática. Diferencia deliberada con DeliveryApiIT de Java, que
// admite 10 reenvíos antes de que exista la automática y acaba enviando 11 (docs/route-inventory.md).
it('limitPerDocument: el tope reserva sitio para la entrega automática que falta', async () => {
  for (let i = 0; i < 9; i++) await request().expect(202);

  const res = await request();

  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ errorCode: 'DELIVERY_LIMIT_REACHED' });
  expect(await invoice.rows()).toHaveLength(9);

  // El worker crea la automática en el sitio reservado: salen 10 correos, no 11.
  expect(await invoice.process()).toBe(10);
  expect(h.smtp.raw(invoice.email)).toHaveLength(10);
  expect(await invoice.rows()).toHaveLength(10);
  expect(await automaticCount()).toBe(1);

  await request().expect(409);
  expect(await invoice.process()).toBe(0);
  expect(h.smtp.raw(invoice.email)).toHaveLength(10);
});

it('con la entrega automática ya creada quedan nueve reenvíos', async () => {
  await invoice.process();
  for (let i = 0; i < 9; i++) await request().expect(202);

  await request().expect(409);

  expect(await invoice.process()).toBe(9);
  expect(h.smtp.raw(invoice.email)).toHaveLength(10);
});

it('sin correo del cliente no hay entrega automática que reservar', async () => {
  await h.db.query('UPDATE fiscal_documents SET customer_email = NULL WHERE id = $1', [invoice.document]);
  const other = `otra-${randomUUID()}@cliente.test`;
  for (let i = 0; i < 10; i++) await request(invoice.s.owner, { email: other }).expect(202);

  await request(invoice.s.owner, { email: other }).expect(409);

  expect(await invoice.process()).toBe(10);
  expect(h.smtp.raw(other)).toHaveLength(10);
  expect(await automaticCount()).toBe(0);
});

it('con el tope ya alcanzado por reenvíos (datos de Java) no se añade la entrega automática', async () => {
  await insertManual(10);

  expect(await invoice.process()).toBe(10);

  expect(h.smtp.raw(invoice.email)).toHaveLength(10);
  expect(await invoice.rows()).toHaveLength(10);
  expect(await automaticCount()).toBe(0);
});

it('peticiones simultáneas no superan el tope', async () => {
  const statuses = (await Promise.all(Array.from({ length: 14 }, () => request()))).map((res) => res.status);

  expect(statuses.filter((status) => status === 202)).toHaveLength(9);
  expect(statuses.filter((status) => status === 409)).toHaveLength(5);
  expect(await invoice.rows()).toHaveLength(9);
});

it('peticiones a la vez que el worker crea la automática no superan el tope', async () => {
  // Archivado de antemano: así el worker llega a crear la entrega automática mientras entran las peticiones.
  await h.testApp.app.get(DocumentArchiver).archive(invoice.s.tenant, invoice.document);
  await insertManual(7);

  const [sent, ...responses] = await Promise.all([
    invoice.process(),
    ...Array.from({ length: 6 }, async () => (await request()).status),
  ]);

  expect(sent).toBeGreaterThanOrEqual(8);
  expect(responses.filter((status) => status === 202)).toHaveLength(2);
  expect(await invoice.rows()).toHaveLength(10);
  expect(await automaticCount()).toBe(1);
  await invoice.process();
  expect(h.smtp.raw(invoice.email)).toHaveLength(10);
});

it('billerCanResendAndAuditorCanOnlyList', async () => {
  const { tenant } = invoice.s;
  await request(await memberToken(h.http, h.db, tenant, 'BILLER')).expect(202);

  const auditor = await memberToken(h.http, h.db, tenant, 'AUDITOR');
  await request(auditor).expect(403);
  const res = await list(auditor).expect(200);
  expect(res.body).toHaveLength(1);
});

it('foreignDocumentIsNotFound', async () => {
  const other = await billingScenario(h.http, h.db);

  await list(other.owner).expect(404);
  await request(other.owner).expect(404);
  await list(invoice.s.owner, randomUUID()).expect(404);
  expect(await invoice.rows()).toEqual([]);
});

it('resendIsRefusedWhileEmailIsDisabled', async () => {
  const offline = await startTestApp(h.stack, { EINVOICE_WORKER_ENABLED: 'false' });
  try {
    const res = await offline.http.post(url()).set('Authorization', bearer(invoice.s.owner));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      errorCode: 'DELIVERY_DISABLED',
      detail: 'El envío de comprobantes por correo no está habilitado',
    });
  } finally {
    await offline.close();
  }
  expect(await invoice.rows()).toEqual([]);
});
