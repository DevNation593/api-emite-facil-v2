import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { fiscalDateOf } from '../../../src/sequence/fiscal-clock.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  type BillingScenario,
  billingScenario,
  createEmissionPoint,
  createEstablishment,
  createTaxpayer,
  creditLine,
  creditNoteJson,
  creditNoteRequest,
  invoiceBody,
  invoiceJson,
  invoiceRequest,
  issueInvoice,
  manualCreditNoteJson,
  memberToken,
  setState,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

/*
 * Traducción completa de CreditNoteApiIT: nota de crédito por la API sobre una factura autorizada de la
 * plataforma (líneas y comprador copiados, tope por línea y saldo de la factura) o sobre una factura
 * escrita a mano, con líneas del catálogo. Más los textos de error de test/golden/http/e3.json, la
 * huella de la petición y los motivos y fechas que el XML no admite.
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

const creditNote = (body: unknown, token: string = s.owner, key: string = randomUUID()) =>
  creditNoteRequest(http(), token, body, key);

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

async function row(document: string): Promise<Record<string, unknown>> {
  return (
    await db.query(
      `SELECT document_type, state, customer_id, customer_id_number, customer_name, modified_document_id,
         modified_doc_code, modified_doc_number, to_char(modified_doc_date, 'YYYY-MM-DD') AS modified_doc_date,
         subtotal, total_tax, total, content->>'reason' AS reason,
         content->'lines'->0->>'invoiceLineNo' AS invoice_line_no, content->'lines'->0->>'mainCode' AS main_code,
         content->'lines'->0->>'description' AS description, content->'lines'->0->>'taxRateCode' AS tax_rate_code,
         content->'lines'->0->>'quantity' AS quantity, content->'lines'->0->>'productId' AS product_id
       FROM fiscal_documents WHERE id = $1`,
      [document],
    )
  ).rows[0] as Record<string, unknown>;
}

async function notes(): Promise<number> {
  const res = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM fiscal_documents WHERE tenant_id = $1 AND document_type = '04'",
    [s.tenant],
  );
  return Number(res.rows[0]!.n);
}

/** Siguiente secuencial de notas de crédito del punto; nulo si nunca se reservó uno. */
async function nextCreditNoteValue(): Promise<number | null> {
  const res = await db.query<{ next_value: string }>(
    "SELECT next_value FROM document_sequences WHERE emission_point_id = $1 AND document_type = '04'",
    [s.point],
  );
  return res.rows[0] === undefined ? null : Number(res.rows[0].next_value);
}

async function lineDiscount(note: string): Promise<string> {
  const res = await db.query<{ discount: string }>(
    "SELECT content->'lines'->0->>'discount' AS discount FROM fiscal_documents WHERE id = $1",
    [note],
  );
  return res.rows[0]!.discount;
}

function plusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const todayInEcuador = () => fiscalDateOf(new Date());

/** 2 × 10.00 con 1.00 de descuento (19.00 + IVA = 21.85). */
const discountedInvoice = async () =>
  authorized(
    await issueInvoice(
      http(),
      s.owner,
      invoiceBody(s, s.customer, [{ productId: s.product, quantity: '2', discount: '1.00' }], '21.85'),
    ),
  );

it('creditNoteFromInvoiceCopiesLinesAndBuyer', async () => {
  const note = await issued(creditNote(creditNoteJson(s, invoice, [creditLine(1, '1')])));

  const invoiceRow = (
    await db.query(
      "SELECT customer_id_number, customer_name, to_char(issue_date, 'YYYY-MM-DD') AS issue_date FROM fiscal_documents WHERE id = $1",
      [invoice],
    )
  ).rows[0] as Record<string, unknown>;
  const noteRow = await row(note);
  expect(noteRow).toMatchObject({
    document_type: '04',
    state: 'RESERVED',
    customer_id: s.customer,
    customer_id_number: invoiceRow.customer_id_number,
    customer_name: invoiceRow.customer_name,
    modified_document_id: invoice,
    modified_doc_code: '01',
    modified_doc_number: '001-001-000000001',
    modified_doc_date: invoiceRow.issue_date,
    reason: 'Devolución de mercadería',
    invoice_line_no: '1',
    main_code: 'SRV-001',
    description: 'Servicio de consultoría',
    tax_rate_code: '4',
    product_id: s.product,
    total: '11.50',
    total_tax: '1.50',
  });
  const audit = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM audit_events WHERE action = 'CREDIT_NOTE_RESERVED' AND entity_id = $1",
    [note],
  );
  expect(Number(audit.rows[0]!.n)).toBe(1);

  // El contenido congelado de la línea, con la escala de cada importe.
  const content = await db.query<{ line: Record<string, unknown> }>(
    "SELECT content->'lines'->0 AS line FROM fiscal_documents WHERE id = $1",
    [note],
  );
  expect(content.rows[0]!.line).toMatchObject({
    invoiceLineNo: 1,
    quantity: '1',
    unitPrice: '10.000000',
    discount: '0.00',
    taxRate: '15.00',
    subtotal: '10.00',
    taxAmount: '1.50',
  });
  // Solo DOCUMENT_RESERVED en el outbox, con el id y nada más.
  const outbox = await db.query<{ event_type: string; payload: unknown }>(
    'SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1',
    [note],
  );
  expect(outbox.rows).toEqual([{ event_type: 'DOCUMENT_RESERVED', payload: { documentId: note } }]);
});

it('theBuyerIsTheOneFrozenInTheInvoice', async () => {
  const buyer = async (id: string) =>
    (
      await db.query(
        `SELECT customer_id_type, customer_id_number, customer_name, customer_address, customer_email
         FROM fiscal_documents WHERE id = $1`,
        [id],
      )
    ).rows[0] as Record<string, unknown>;
  const original = await buyer(invoice);
  // Después de la factura el cliente se edita y se archiva (borrado lógico, V17).
  await db.query(
    `UPDATE customers SET name = 'Otro Nombre', id_number = '0912345678', email = 'otro@example.test',
       address = 'Otra dirección', deleted_at = now() WHERE id = $1`,
    [s.customer],
  );

  const note = await issued(creditNote(creditNoteJson(s, invoice, [creditLine(1, '1')])));

  const noteBuyer = await buyer(note);
  expect(noteBuyer).toEqual(original);
  expect(noteBuyer.customer_name).toBe('María Pérez');
  expect((await row(note)).customer_id).toBe(s.customer);
});

it('anOmittedDiscountIsProratedFromTheInvoiceLine', async () => {
  // Devolver 1 sin descuento lleva la mitad: 0.50, y 9.50 + IVA 1.43 = 10.93.
  const half = await issued(creditNote(creditNoteJson(s, await discountedInvoice(), [creditLine(1, '1')])));
  expect(await lineDiscount(half)).toBe('0.50');
  expect((await row(half)).total).toBe('10.93');

  // Devolver toda la cantidad lleva el descuento original entero.
  const whole = await issued(creditNote(creditNoteJson(s, await discountedInvoice(), [creditLine(1, '2')])));
  expect(await lineDiscount(whole)).toBe('1.00');
  expect((await row(whole)).total).toBe('21.85');
});

it('theDiscountCannotGoBelowTheProratedOne', async () => {
  // Por 1 unidad, el descuento mínimo es 0.50.
  const discounted = await discountedInvoice();

  // Sin descuento, la línea acreditaría 10.00 contra los 9.50 facturados.
  const zero = await rejected(
    creditNote(creditNoteJson(s, discounted, [{ invoiceLineNo: 1, quantity: '1', discount: '0' }])),
    422,
    'CREDIT_LINE_EXCEEDS_INVOICE',
  );
  expect(zero.detail).toBe(
    'La línea 1 no puede llevar un descuento menor que el de la factura en proporción a la cantidad: 0.50',
  );
  await rejected(
    creditNote(creditNoteJson(s, discounted, [{ invoiceLineNo: 1, quantity: '1', discount: '0.49' }])),
    422,
    'CREDIT_LINE_EXCEEDS_INVOICE',
  );
  expect(await notes()).toBe(0);

  const prorated = await issued(
    creditNote(creditNoteJson(s, discounted, [{ invoiceLineNo: 1, quantity: '1', discount: '0.50' }])),
  );
  expect(await lineDiscount(prorated)).toBe('0.50');
  const higher = await issued(
    creditNote(creditNoteJson(s, discounted, [{ invoiceLineNo: 1, quantity: '1', discount: '0.75' }])),
  );
  expect(await lineDiscount(higher)).toBe('0.75');
});

it('lineAboveTheOriginalIsRejected', async () => {
  const above = await rejected(
    creditNote(creditNoteJson(s, invoice, [creditLine(1, '3')])),
    422,
    'CREDIT_LINE_EXCEEDS_INVOICE',
  );
  expect(above.detail).toBe('La línea 1 supera la cantidad o el precio unitario de la factura');
  await rejected(
    creditNote(creditNoteJson(s, invoice, [{ invoiceLineNo: 1, quantity: '1', unitPrice: '10.01' }])),
    422,
    'CREDIT_LINE_EXCEEDS_INVOICE',
  );
  const unknown = await rejected(
    creditNote(creditNoteJson(s, invoice, [creditLine(9, '1')])),
    422,
    'CREDIT_LINE_UNKNOWN',
  );
  expect(unknown.detail).toBe('La factura no tiene la línea 9');

  // Una línea de la factura no se repite en la misma nota.
  const repeated = await rejected(
    creditNote(creditNoteJson(s, invoice, [creditLine(1, '1'), creditLine(1, '1')])),
    400,
    'VALIDATION_FAILED',
  );
  expect(repeated).toMatchObject({
    detail: 'La petición no cumple las reglas de validación',
    errors: [{ field: 'lines[1].invoiceLineNo', message: 'La línea de la factura se repite' }],
  });
  // Con factura, las líneas se toman de ella, no del catálogo.
  const fromCatalog = await rejected(
    creditNote(creditNoteJson(s, invoice, [{ productId: s.product, quantity: '1' }])),
    400,
    'VALIDATION_FAILED',
  );
  expect(fromCatalog.errors).toEqual([
    { field: 'lines[0]', message: 'Con invoiceId, la línea lleva invoiceLineNo y no productId' },
  ]);
  expect(await notes()).toBe(0);
});

it('creditCannotExceedTheInvoice', async () => {
  await issued(creditNote(creditNoteJson(s, invoice, [creditLine(1, '2')])));

  const exceeded = await rejected(
    creditNote(creditNoteJson(s, invoice, [{ invoiceLineNo: 1, quantity: '1', unitPrice: '0.01' }])),
    422,
    'CREDIT_EXCEEDS_INVOICE',
  );
  expect(exceeded.detail).toBe('Las notas de crédito de la factura superarían su total; saldo disponible: 0.00');
  expect(await notes()).toBe(1);
});

it('rejectedNotesDoNotConsumeBalance', async () => {
  const first = await issued(creditNote(creditNoteJson(s, invoice, [creditLine(1, '2')])));
  await setState(db, first, 'NOT_AUTHORIZED');

  await issued(creditNote(creditNoteJson(s, invoice, [creditLine(1, '2')])));
});

it('concurrentNotesNeverExceedTheInvoice', async () => {
  // Cada una por el 60 %: 1.2 × 10.00 + IVA = 13.80 de 23.00.
  const body = creditNoteJson(s, invoice, [creditLine(1, '1.2')]);
  const results = await Promise.all([creditNote(body), creditNote(body)]);

  expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([202, 422]);
  const refused = results.find((res) => res.status === 422)!;
  expect((refused.body as { errorCode: string }).errorCode).toBe('CREDIT_EXCEEDS_INVOICE');
  expect((refused.body as { detail: string }).detail).toBe(
    'Las notas de crédito de la factura superarían su total; saldo disponible: 9.20',
  );
  expect(await notes()).toBe(1);
});

it('invoiceMustBeAuthorizedSameIssuerAndOwn', async () => {
  const reserved = await issueInvoice(http(), s.owner, invoiceJson(s, '2', '23.00'));
  await rejected(
    creditNote(creditNoteJson(s, reserved, [creditLine(1, '1')])),
    422,
    'MODIFIED_INVOICE_NOT_AUTHORIZED',
  );

  const otherIssuer = await createTaxpayer(http(), s.owner);
  await createEmissionPoint(http(), s.owner, await createEstablishment(http(), s.owner, otherIssuer, '001'), '001');
  const otherIssuerInvoice = await authorized(
    await issueInvoice(http(), s.owner, { ...invoiceJson(s, '2', '23.00'), taxpayerId: otherIssuer }),
  );
  await rejected(
    creditNote(creditNoteJson(s, otherIssuerInvoice, [creditLine(1, '1')])),
    422,
    'MODIFIED_INVOICE_OTHER_ISSUER',
  );

  // La factura de otra empresa responde como una inexistente.
  const other = await billingScenario(http(), db);
  const foreign = await rejected(
    creditNote(creditNoteJson(other, invoice, [creditLine(1, '1')]), other.owner),
    404,
    'NOT_FOUND',
  );
  const missing = await rejected(
    creditNote(creditNoteJson(other, randomUUID(), [creditLine(1, '1')]), other.owner),
    404,
    'NOT_FOUND',
  );
  expect(foreign.detail).toBe(missing.detail);

  const note = await authorized(await issued(creditNote(creditNoteJson(s, invoice, [creditLine(1, '1')]))));
  await rejected(
    creditNote(creditNoteJson(s, note, [creditLine(1, '1')])),
    422,
    'MODIFIED_DOCUMENT_NOT_INVOICE',
  );
});

it('manualCreditNoteUsesCatalogLines', async () => {
  const note = await issued(creditNote(manualCreditNoteJson(s, '001-002-000000123', '2024-01-15', '1')));

  const noteRow = await row(note);
  expect(noteRow).toMatchObject({
    modified_document_id: null,
    modified_doc_code: '01',
    modified_doc_number: '001-002-000000123',
    modified_doc_date: '2024-01-15',
    customer_id: s.customer,
    main_code: 'SRV-001',
    product_id: s.product,
    invoice_line_no: null,
    total: '11.50',
  });
});

it('modifiedDocumentIsRequiredOnce', async () => {
  const manual = manualCreditNoteJson(s, '001-002-000000123', '2024-01-15', '1');
  const { modifiedDocument: _modified, customerId: _customer, ...withoutAny } = manual;
  const required = await rejected(creditNote(withoutAny), 400, 'MODIFIED_DOCUMENT_REQUIRED');
  expect(required.detail).toBe(
    'La nota lleva invoiceId, o modifiedDocument con customerId; no las dos cosas ni ninguna',
  );

  await rejected(creditNote({ invoiceId: invoice, ...manual }), 400, 'MODIFIED_DOCUMENT_REQUIRED');

  await rejected(
    creditNote({ customerId: s.customer, ...creditNoteJson(s, invoice, [creditLine(1, '1')]) }),
    400,
    'MODIFIED_DOCUMENT_REQUIRED',
  );

  const { customerId: _removed, ...withoutCustomer } = manual;
  await rejected(creditNote(withoutCustomer), 400, 'MODIFIED_DOCUMENT_REQUIRED');
  expect(await notes()).toBe(0);
});

it('modifiedDocumentCannotBeLater', async () => {
  const tomorrow = plusDays(todayInEcuador(), 1);
  const later = await rejected(
    creditNote(manualCreditNoteJson(s, '001-002-000000123', tomorrow, '1')),
    422,
    'INVALID_MODIFIED_DOCUMENT_DATE',
  );
  expect(later.detail).toBe('La fecha del comprobante que se modifica no puede ser posterior a la de la nota');

  await db.query('UPDATE fiscal_documents SET issue_date = $1 WHERE id = $2', [tomorrow, invoice]);
  await rejected(
    creditNote(creditNoteJson(s, invoice, [creditLine(1, '1')])),
    422,
    'INVALID_MODIFIED_DOCUMENT_DATE',
  );
  expect(await notes()).toBe(0);
});

it('idempotentRetryReturnsTheSameNote', async () => {
  const key = randomUUID();
  const body = creditNoteJson(s, invoice, [creditLine(1, '1')]);
  const first = await issued(creditNote(body, s.owner, key));

  expect(await issued(creditNote(body, s.owner, key))).toBe(first);
  await rejected(
    creditNote(creditNoteJson(s, invoice, [creditLine(1, '2')]), s.owner, key),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  await rejected(creditNoteRequest(http(), s.owner, body), 400, 'IDEMPOTENCY_KEY_REQUIRED');
  expect(await notes()).toBe(1);
});

it('invalidLineAmountsUseTheInvoiceRules', async () => {
  await rejected(
    creditNote(creditNoteJson(s, invoice, [{ invoiceLineNo: 1, quantity: '1', discount: '10.01' }])),
    422,
    'INVALID_LINE',
  );
  await rejected(creditNote(creditNoteJson(s, invoice, [creditLine(1, '0')])), 422, 'INVALID_LINE');
  expect(await notes()).toBe(0);
});

it('reasonIsRequiredAndSingleLine', async () => {
  const body = creditNoteJson(s, invoice, [creditLine(1, '1')]);
  await rejected(creditNote({ ...body, reason: '' }), 400, 'VALIDATION_FAILED');
  await rejected(creditNote({ ...body, reason: 'Devolución\nparcial' }), 400, 'VALIDATION_FAILED');
  await rejected(creditNote({ ...body, reason: 'x'.repeat(301) }), 400, 'VALIDATION_FAILED');
  expect(await notes()).toBe(0);
});

describe('más allá de CreditNoteApiIT', () => {
  it('el motivo llega recortado y la huella es la del cuerpo leído, como Java', async () => {
    const key = randomUUID();
    const text = (quantity: string, lineNo: string) =>
      `{"taxpayerId":"${s.taxpayer}","establishmentCode":"001","emissionPointCode":"001",` +
      `"reason":"  Devolución  ","invoiceId":"${invoice}","lines":[{"invoiceLineNo":${lineNo},"quantity":${quantity}}]}`;
    const first = await issued(creditNote(text('1', '1'), s.owner, key));
    expect((await row(first)).reason).toBe('Devolución');

    // Jackson lee 1 y "1" como el mismo Integer y el mismo String: es la misma petición.
    expect(await issued(creditNote(text('"1"', '"1"'), s.owner, key))).toBe(first);
    // 1.0 es otro texto de cantidad: otra petición.
    await rejected(creditNote(text('1.0', '1'), s.owner, key), 409, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('una clave ya usada por una factura o por una nota es de otra petición (e3.json)', async () => {
    const invoiceKey = randomUUID();
    await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'), invoiceKey);
    await rejected(
      creditNote(creditNoteJson(s, invoice, [creditLine(1, '1')]), s.owner, invoiceKey),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );

    const noteKey = randomUUID();
    await issued(creditNote(creditNoteJson(s, invoice, [creditLine(1, '1')]), s.owner, noteKey));
    await rejected(invoiceRequest(http(), s.owner, invoiceJson(s, '1', '11.50'), noteKey), 409, 'IDEMPOTENCY_KEY_REUSED');
    expect(await notes()).toBe(1);
  });

  it('un motivo con un sustituto suelto es 422 DOCUMENT_XML_INVALID y no consume el secuencial', async () => {
    const body = { ...creditNoteJson(s, invoice, [creditLine(1, '1')]), reason: 'Devolución \ud800' };
    const res = await rejected(creditNote(body), 422, 'DOCUMENT_XML_INVALID');
    expect(res.detail).toBe('Carácter no admitido en XML: U+d800');
    expect(await notes()).toBe(0);
    expect(await nextCreditNoteValue()).toBeNull();
  });

  it('una fecha de factura a mano que el XML no admite es 422, no 500, y no consume el secuencial', async () => {
    // Año negativo (LocalDate de Java): se escribe como año de la era y el XSD lo rechaza.
    for (const date of ['-0001-01-01', '0000-12-31', -800000]) {
      await rejected(
        creditNote({
          ...manualCreditNoteJson(s, '001-002-000000123', '2024-01-15', '1'),
          modifiedDocument: { code: '01', number: '001-002-000000123', issueDate: date },
        }),
        422,
        'DOCUMENT_XML_INVALID',
      );
    }
    // Un año de cinco cifras es posterior a la nota.
    await rejected(
      creditNote(manualCreditNoteJson(s, '001-002-000000123', '+10000-01-01', '1')),
      422,
      'INVALID_MODIFIED_DOCUMENT_DATE',
    );
    expect(await notes()).toBe(0);
    expect(await nextCreditNoteValue()).toBeNull();
  });

  it('valida el cuerpo antes de la cabecera Idempotency-Key (e3.json)', async () => {
    const res = await rejected(creditNoteRequest(http(), s.owner, {}), 400, 'VALIDATION_FAILED');
    expect(res.errors).toEqual(
      expect.arrayContaining([
        { field: 'emissionPointCode', message: 'must not be null' },
        { field: 'establishmentCode', message: 'must not be null' },
        { field: 'lines', message: 'must not be null' },
        { field: 'reason', message: 'must not be blank' },
        { field: 'taxpayerId', message: 'must not be null' },
      ]),
    );
    expect(res.errors).toHaveLength(5);
  });

  it('un rol sin facturación no emite notas', async () => {
    const viewer = await memberToken(http(), db, s.tenant, 'AUDITOR');
    const res = await creditNote(creditNoteJson(s, invoice, [creditLine(1, '1')]), viewer);
    expect(res.status).toBe(403);
    expect(await notes()).toBe(0);
  });
});
