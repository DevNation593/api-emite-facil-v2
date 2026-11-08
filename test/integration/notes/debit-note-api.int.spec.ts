import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { fiscalDateOf } from '../../../src/sequence/fiscal-clock.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  type BillingScenario,
  billingScenario,
  createCustomer,
  createProduct,
  DEBIT_PAYMENT_16_50,
  DEBIT_REASONS,
  debitNoteJson,
  debitNoteRequest,
  invoiceBody,
  invoiceJson,
  invoiceRequest,
  issueInvoice,
  setState,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

/*
 * Traducción completa de DebitNoteApiIT: nota de débito por la API, con motivos y su IVA y un pago por el
 * total, sobre una factura autorizada de la plataforma (comprador copiado) o sobre una factura escrita a
 * mano. Más los textos de error de test/golden/http/e3.json, la huella de la petición y el plazo del pago.
 */
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let s: BillingScenario;
/** Factura autorizada de 2 × 10.00 + IVA 15 % = 23.00. */
let invoice: string;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack, { EINVOICE_RATE_LIMIT_WRITES: '1000000' });
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
  invoice = await authorized(await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00')));
});

const http = () => testApp.http;

async function authorized(document: string): Promise<string> {
  await setState(db, document, 'AUTHORIZED');
  return document;
}

const debitNote = (body: unknown, token: string = s.owner, key: string = randomUUID()) =>
  debitNoteRequest(http(), token, body, key);

const body = (invoiceId: string, reasons: unknown[] = DEBIT_REASONS, payments: unknown[] = DEBIT_PAYMENT_16_50) =>
  debitNoteJson(s, invoiceId, reasons, payments);

const payment = (amount: string, extra: Record<string, unknown> = {}) => [{ methodCode: '20', amount, ...extra }];
const oneReason = { reason: 'Intereses', value: '1.00', ivaRateCode: '0' };

async function issued(call: Promise<{ status: number; text: string; body: unknown }>): Promise<string> {
  const res = await call;
  if (res.status !== 202) throw new Error(`Se esperaba 202 y llegó ${res.status}: ${res.text}`);
  return (res.body as { id: string }).id;
}

async function rejected(
  call: Promise<{ status: number; text: string; body: unknown }>,
  status: number,
  errorCode: string,
): Promise<Record<string, unknown>> {
  const res = await call;
  expect({ status: res.status, errorCode: (res.body as { errorCode?: string }).errorCode }).toEqual({ status, errorCode });
  return res.body as Record<string, unknown>;
}

async function notes(): Promise<number> {
  const res = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM fiscal_documents WHERE tenant_id = $1 AND document_type = '05'",
    [s.tenant],
  );
  return Number(res.rows[0]!.n);
}

/** Siguiente secuencial de notas de débito del punto; nulo si nunca se reservó uno. */
async function nextDebitNoteValue(): Promise<number | null> {
  const res = await db.query<{ next_value: string }>(
    "SELECT next_value FROM document_sequences WHERE emission_point_id = $1 AND document_type = '05'",
    [s.point],
  );
  return res.rows[0] === undefined ? null : Number(res.rows[0].next_value);
}

/** Un valor del contenido congelado de la nota (`->'reasons'->0->>'reason'`). */
async function content(document: string, path: string): Promise<string | null> {
  const res = await db.query<{ v: string | null }>(`SELECT content${path} AS v FROM fiscal_documents WHERE id = $1`, [
    document,
  ]);
  return res.rows[0]!.v;
}

function plusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const todayInEcuador = () => fiscalDateOf(new Date());

function manualBody(reasons: unknown[] = DEBIT_REASONS, payments: unknown[] = DEBIT_PAYMENT_16_50) {
  return {
    taxpayerId: s.taxpayer,
    establishmentCode: '001',
    emissionPointCode: '001',
    modifiedDocument: { code: '01', number: '001-002-000000123', issueDate: '2024-01-15' },
    customerId: s.customer,
    reasons,
    payments,
  };
}

it('debitNoteFromInvoice', async () => {
  const note = await issued(debitNote(body(invoice)));

  const invoiceRow = (
    await db.query('SELECT customer_id_number, customer_name FROM fiscal_documents WHERE id = $1', [invoice])
  ).rows[0] as Record<string, unknown>;
  const row = (
    await db.query(
      `SELECT document_type, state, customer_id, customer_id_number, customer_name, modified_document_id,
         modified_doc_number, subtotal, total_discount, total_tax, total FROM fiscal_documents WHERE id = $1`,
      [note],
    )
  ).rows[0] as Record<string, unknown>;
  expect(row).toMatchObject({
    document_type: '05',
    state: 'RESERVED',
    customer_id: s.customer,
    customer_id_number: invoiceRow.customer_id_number,
    customer_name: invoiceRow.customer_name,
    modified_document_id: invoice,
    modified_doc_number: '001-001-000000001',
    subtotal: '15.00',
    total_discount: '0.00',
    total_tax: '1.50',
    total: '16.50',
  });

  expect(await content(note, "->'reasons'->0->>'reason'")).toBe('Intereses por mora');
  expect(await content(note, "->'reasons'->0->>'taxRateCode'")).toBe('4');
  expect(await content(note, "->'reasons'->1->>'reason'")).toBe('Gastos de cobranza');
  expect(await content(note, "->'reasons'->1->>'taxRateCode'")).toBe('0');
  expect(await content(note, "->'taxes'->0->>'rateCode'")).toBe('0');
  expect(await content(note, "->'taxes'->0->>'base'")).toBe('5.00');
  expect(await content(note, "->'taxes'->1->>'rateCode'")).toBe('4');
  expect(await content(note, "->'taxes'->1->>'amount'")).toBe('1.50');
  expect(await content(note, "->'payments'->0->>'methodCode'")).toBe('20');
  expect(await content(note, "->'payments'->0->>'amount'")).toBe('16.50');
  const audit = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM audit_events WHERE action = 'DEBIT_NOTE_RESERVED' AND entity_id = $1",
    [note],
  );
  expect(Number(audit.rows[0]!.n)).toBe(1);
  // Solo DOCUMENT_RESERVED en el outbox, con el id y nada más.
  const outbox = await db.query<{ event_type: string; payload: unknown }>(
    'SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1',
    [note],
  );
  expect(outbox.rows).toEqual([{ event_type: 'DOCUMENT_RESERVED', payload: { documentId: note } }]);
});

it('paymentMustMatchTotal', async () => {
  const res = await rejected(debitNote(body(invoice, DEBIT_REASONS, payment('16.49'))), 422, 'PAYMENTS_MISMATCH');
  expect(res.detail).toBe('El pago no coincide con el total del comprobante');
  expect(await notes()).toBe(0);
});

it('unknownPaymentMethodIsRejected', async () => {
  await rejected(
    debitNote(body(invoice, DEBIT_REASONS, [{ methodCode: '99', amount: '16.50' }])),
    422,
    'PAYMENT_METHOD_UNKNOWN',
  );
  expect(await notes()).toBe(0);
});

it('unknownTaxRateIsRejected', async () => {
  const res = await rejected(
    debitNote(body(invoice, [{ reason: 'Intereses', value: '10.00', ivaRateCode: '99' }], DEBIT_PAYMENT_16_50)),
    422,
    'TAX_RATE_UNKNOWN',
  );
  expect(res.detail).toBe('La tarifa de IVA del producto no existe');
  expect(await notes()).toBe(0);
});

it('zeroValueIsRejected', async () => {
  const res = await rejected(
    debitNote(body(invoice, [{ reason: 'Intereses', value: '0.00', ivaRateCode: '0' }], payment('0.00'))),
    422,
    'INVALID_LINE',
  );
  expect(res.detail).toBe('El valor del motivo debe ser mayor que cero');
  expect(await notes()).toBe(0);
});

it('manualDebitNote', async () => {
  const note = await issued(debitNote(manualBody()));

  const row = (
    await db.query(
      `SELECT modified_document_id, modified_doc_code, modified_doc_number, customer_id, total
       FROM fiscal_documents WHERE id = $1`,
      [note],
    )
  ).rows[0] as Record<string, unknown>;
  expect(row).toMatchObject({
    modified_document_id: null,
    modified_doc_code: '01',
    modified_doc_number: '001-002-000000123',
    customer_id: s.customer,
    total: '16.50',
  });
});

it('modifiedDocumentIsRequiredOnce', async () => {
  const res = await rejected(debitNote({ customerId: s.customer, ...body(invoice) }), 400, 'MODIFIED_DOCUMENT_REQUIRED');
  expect(res.detail).toBe('La nota lleva invoiceId, o modifiedDocument con customerId; no las dos cosas ni ninguna');
  const { invoiceId: _removed, ...withoutInvoice } = body(invoice);
  await rejected(debitNote(withoutInvoice), 400, 'MODIFIED_DOCUMENT_REQUIRED');
  await rejected(debitNote({ invoiceId: invoice, ...manualBody() }), 400, 'MODIFIED_DOCUMENT_REQUIRED');
  const { customerId: _customer, ...withoutCustomer } = manualBody();
  await rejected(debitNote(withoutCustomer), 400, 'MODIFIED_DOCUMENT_REQUIRED');
  expect(await notes()).toBe(0);
});

it('invoiceMustBeAuthorized', async () => {
  const reserved = await issueInvoice(http(), s.owner, invoiceJson(s, '2', '23.00'));
  await rejected(debitNote(body(reserved)), 422, 'MODIFIED_INVOICE_NOT_AUTHORIZED');
});

it('finalConsumerLimitApplies', async () => {
  const finalConsumer = await createCustomer(http(), s.owner, '07', '9999999999999');
  const book = await createProduct(http(), s.owner, 'LIB-001', '50.00', '0');
  const invoiceToFinalConsumer = await authorized(
    await issueInvoice(http(), s.owner, invoiceBody(s, finalConsumer, [{ productId: book, quantity: '1' }], '50.00')),
  );

  const over = await rejected(
    debitNote(
      body(invoiceToFinalConsumer, [{ reason: 'Intereses', value: '50.01', ivaRateCode: '0' }], payment('50.01')),
    ),
    422,
    'FINAL_CONSUMER_LIMIT_EXCEEDED',
  );
  expect(over.detail).toBe('Una venta a consumidor final no puede superar el monto máximo; identifique al adquirente');

  // Hasta el límite sí se puede.
  await issued(
    debitNote(body(invoiceToFinalConsumer, [{ reason: 'Intereses', value: '50.00', ivaRateCode: '0' }], payment('50.00'))),
  );
  expect(await notes()).toBe(1);
});

it('reasonsAndPaymentLimits', async () => {
  const pay = payment('1.00');
  await rejected(debitNote(body(invoice, [], pay)), 400, 'VALIDATION_FAILED');
  await rejected(debitNote(body(invoice, Array(21).fill(oneReason), pay)), 400, 'VALIDATION_FAILED');
  await rejected(debitNote(body(invoice, [oneReason], [])), 400, 'VALIDATION_FAILED');
  await rejected(debitNote(body(invoice, [oneReason], [...pay, ...pay])), 400, 'VALIDATION_FAILED');
  await rejected(debitNote(body(invoice, [{ ...oneReason, reason: 'Inte\nreses' }], pay)), 400, 'VALIDATION_FAILED');
  await rejected(debitNote(body(invoice, [{ ...oneReason, value: '1.004' }], pay)), 400, 'VALIDATION_FAILED');
  expect(await notes()).toBe(0);

  // Veinte motivos sí caben.
  await issued(debitNote(body(invoice, Array(20).fill(oneReason), payment('20.00'))));
});

describe('más allá de DebitNoteApiIT', () => {
  it('el plazo del pago va con su unidad, y una unidad en blanco cuenta como ausente (e3.json)', async () => {
    const res = await rejected(
      debitNote(body(invoice, DEBIT_REASONS, payment('16.50', { term: '30' }))),
      422,
      'INVALID_PAYMENT_TERM',
    );
    expect(res.detail).toBe('El plazo de una forma de pago lleva su unidad de tiempo');
    await rejected(
      debitNote(body(invoice, DEBIT_REASONS, payment('16.50', { timeUnit: 'dias' }))),
      422,
      'INVALID_PAYMENT_TERM',
    );
    await rejected(
      debitNote(body(invoice, DEBIT_REASONS, payment('16.50', { term: '30', timeUnit: '   ' }))),
      422,
      'INVALID_PAYMENT_TERM',
    );
    expect(await notes()).toBe(0);

    const note = await issued(debitNote(body(invoice, DEBIT_REASONS, payment('16.50', { term: '30', timeUnit: ' dias ' }))));
    expect(await content(note, "->'payments'->0->>'term'")).toBe('30');
    expect(await content(note, "->'payments'->0->>'timeUnit'")).toBe('dias');
    const blank = await issued(debitNote(body(invoice, DEBIT_REASONS, payment('16.50', { timeUnit: '  ' }))));
    expect(await content(blank, "->'payments'->0->>'term'")).toBeNull();
    expect(await content(blank, "->'payments'->0->>'timeUnit'")).toBeNull();
  });

  it('la razón llega recortada y la huella es la del cuerpo leído, como Java', async () => {
    const key = randomUUID();
    const text = (value: string) =>
      `{"taxpayerId":"${s.taxpayer}","establishmentCode":"001","emissionPointCode":"001","invoiceId":"${invoice}",` +
      `"reasons":[{"reason":"  Intereses  ","value":${value},"ivaRateCode":4}],` +
      `"payments":[{"methodCode":"20","amount":"5.75"}]}`;
    const first = await issued(debitNote(text('5.00'), s.owner, key));
    expect(await content(first, "->'reasons'->0->>'reason'")).toBe('Intereses');

    // Jackson lee 4 y "4" como el mismo String, y "5.00" y 5.00 con el mismo texto: es la misma petición.
    expect(await issued(debitNote(text('"5.00"').replace('"ivaRateCode":4', '"ivaRateCode":"4"'), s.owner, key))).toBe(
      first,
    );
    // 5.0 es otro texto de valor: otra petición.
    await rejected(debitNote(text('5.0'), s.owner, key), 409, 'IDEMPOTENCY_KEY_REUSED');
    expect(await notes()).toBe(1);
  });

  it('idempotentRetryReturnsTheSameNote y la clave es de una sola petición', async () => {
    const key = randomUUID();
    const first = await issued(debitNote(body(invoice), s.owner, key));
    expect(await issued(debitNote(body(invoice), s.owner, key))).toBe(first);
    await rejected(
      debitNote(body(invoice, [{ ...oneReason, reason: 'Otro motivo' }], payment('1.00')), s.owner, key),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    await rejected(debitNoteRequest(http(), s.owner, body(invoice)), 400, 'IDEMPOTENCY_KEY_REQUIRED');

    const invoiceKey = randomUUID();
    await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'), invoiceKey);
    await rejected(debitNote(body(invoice), s.owner, invoiceKey), 409, 'IDEMPOTENCY_KEY_REUSED');
    const noteKey = randomUUID();
    await issued(debitNote(body(invoice), s.owner, noteKey));
    await rejected(invoiceRequest(http(), s.owner, invoiceJson(s, '1', '11.50'), noteKey), 409, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('la factura de otra empresa responde como una inexistente, y la de otro emisor se rechaza', async () => {
    const other = await billingScenario(http(), db);
    const foreign = await rejected(debitNote(debitNoteJson(other, invoice), other.owner), 404, 'NOT_FOUND');
    const missing = await rejected(debitNote(debitNoteJson(other, randomUUID()), other.owner), 404, 'NOT_FOUND');
    expect(foreign.detail).toBe(missing.detail);
    expect(await notes()).toBe(0);
  });

  it('la fecha de la factura no puede ser posterior a la de la nota', async () => {
    const tomorrow = plusDays(todayInEcuador(), 1);
    const manual = { ...manualBody(), modifiedDocument: { code: '01', number: '001-002-000000123', issueDate: tomorrow } };
    const later = await rejected(debitNote(manual), 422, 'INVALID_MODIFIED_DOCUMENT_DATE');
    expect(later.detail).toBe('La fecha del comprobante que se modifica no puede ser posterior a la de la nota');

    await db.query('UPDATE fiscal_documents SET issue_date = $1 WHERE id = $2', [tomorrow, invoice]);
    await rejected(debitNote(body(invoice)), 422, 'INVALID_MODIFIED_DOCUMENT_DATE');
    await rejected(debitNote({ ...body(invoice), issueDate: plusDays(todayInEcuador(), 1) }), 422, 'INVALID_ISSUE_DATE');
    expect(await notes()).toBe(0);
  });

  it('una razón con un sustituto suelto es 422 DOCUMENT_XML_INVALID y no consume el secuencial', async () => {
    const res = await rejected(
      debitNote(body(invoice, [{ ...DEBIT_REASONS[0], reason: 'Intereses \ud800' }], payment('11.50'))),
      422,
      'DOCUMENT_XML_INVALID',
    );
    expect(res.detail).toBe('Carácter no admitido en XML: U+d800');
    expect(await notes()).toBe(0);
    expect(await nextDebitNoteValue()).toBeNull();
  });

  it('un importe que no cabe en el documento es 422 AMOUNT_TOO_LARGE', async () => {
    await rejected(
      debitNote(
        body(invoice, [{ reason: 'Intereses', value: '999999999999.99', ivaRateCode: '4' }], payment('999999999999.99')),
      ),
      422,
      'AMOUNT_TOO_LARGE',
    );
    expect(await notes()).toBe(0);
  });
});
