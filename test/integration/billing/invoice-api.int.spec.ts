import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { fiscalDateOf } from '../../../src/sequence/fiscal-clock.js';
import { isValidAccessKey } from '../../../src/sequence/access-key.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  type BillingScenario,
  billingScenario,
  createCustomer,
  createProduct,
  invoiceBody,
  invoiceJson,
  invoiceLine,
  invoiceRequest,
  issueInvoice,
  memberToken,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

/*
 * Traducción de InvoiceApiIT. Lo que Java comprueba con GET /documents/{id} (Task 8) se lee aquí por
 * SQL de las columnas del comprobante, con su escala; listsDocumentsOfTheTenant,
 * listFiltersByDocumentType, unknownDocumentTypeIs400 y remissionGuideHasNullTotal llegan con la
 * consulta de comprobantes.
 */
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let s: BillingScenario;

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
});

const http = () => testApp.http;
const today = () => fiscalDateOf(new Date());
function plusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const send = (token: string, body: unknown) => invoiceRequest(http(), token, body, randomUUID());

async function documentCount(): Promise<number> {
  const res = await db.query<{ n: string }>('SELECT count(*) AS n FROM fiscal_documents WHERE tenant_id = $1', [
    s.tenant,
  ]);
  return Number(res.rows[0]!.n);
}

async function nextValue(): Promise<number | null> {
  const res = await db.query<{ next_value: string }>(
    'SELECT next_value FROM document_sequences WHERE emission_point_id = $1',
    [s.point],
  );
  return res.rows[0] === undefined ? null : Number(res.rows[0].next_value);
}

async function document(id: string): Promise<Record<string, unknown>> {
  return (
    await db.query(
      `SELECT document_type, state, environment, taxpayer_id, establishment_code, emission_point_code, sequence,
         access_key, to_char(issue_date, 'YYYY-MM-DD') AS issue_date, currency, customer_id_type,
         customer_id_number, customer_name, subtotal, total_discount, total_tax, total
       FROM fiscal_documents WHERE id = $1`,
      [id],
    )
  ).rows[0] as Record<string, unknown>;
}

const lines = async (id: string) =>
  (
    await db.query(
      `SELECT main_code, description, quantity, unit_price, discount, subtotal, tax_amount
       FROM fiscal_document_lines WHERE document_id = $1 ORDER BY line_no`,
      [id],
    )
  ).rows;
const taxes = async (id: string) =>
  (
    await db.query(
      `SELECT tax_code, rate_code, rate, base, amount FROM fiscal_document_taxes WHERE document_id = $1
       ORDER BY CAST(rate_code AS integer)`,
      [id],
    )
  ).rows;
const payments = async (id: string) =>
  (
    await db.query('SELECT method_code, amount FROM fiscal_document_payments WHERE document_id = $1 ORDER BY line_no', [
      id,
    ])
  ).rows;

it('el facturador emite una factura', async () => {
  const biller = await memberToken(http(), db, s.tenant, 'BILLER');
  const res = await send(biller, invoiceJson(s, '2', '23.00')).expect(202);
  expect(Object.keys(res.body)).toEqual(['id', 'state', 'statusUrl']);
  const id = (res.body as { id: string }).id;
  expect(res.body).toEqual({ id, state: 'RESERVED', statusUrl: `/api/v1/documents/${id}` });

  const row = await document(id);
  expect(row).toMatchObject({
    document_type: '01',
    state: 'RESERVED',
    environment: '1',
    taxpayer_id: s.taxpayer,
    establishment_code: '001',
    emission_point_code: '001',
    sequence: 1,
    issue_date: today(),
    currency: 'USD',
    customer_id_type: '05',
    customer_id_number: '1712345678',
    customer_name: 'María Pérez',
    subtotal: '20.00',
    total_discount: '0.00',
    total_tax: '3.00',
    total: '23.00',
  });
  expect(await taxes(id)).toEqual([{ tax_code: '2', rate_code: '4', rate: '15.00', base: '20.00', amount: '3.00' }]);
  expect(await lines(id)).toEqual([
    {
      main_code: 'SRV-001',
      description: 'Servicio de consultoría',
      quantity: '2.000000',
      unit_price: '10.000000',
      discount: '0.00',
      subtotal: '20.00',
      tax_amount: '3.00',
    },
  ]);
  expect(await payments(id)).toEqual([{ method_code: '20', amount: '23.00' }]);

  const accessKey = row.access_key as string;
  expect(isValidAccessKey(accessKey)).toBe(true);
  const [year, month, day] = today().split('-');
  expect(accessKey.startsWith(`${day}${month}${year}01${s.ruc}1001001000000001`)).toBe(true);
  expect(accessKey.charAt(47)).toBe('1');
});

it('la segunda factura toma el secuencial siguiente', async () => {
  const first = await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
  const second = await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
  const rows = await db.query<{ sequence: number }>(
    'SELECT sequence FROM fiscal_documents WHERE id IN ($1, $2) ORDER BY sequence',
    [first, second],
  );
  expect(rows.rows.map((r) => r.sequence)).toEqual([1, 2]);
  const keys = await db.query<{ n: string }>(
    'SELECT count(DISTINCT access_key) AS n FROM fiscal_documents WHERE id IN ($1, $2)',
    [first, second],
  );
  expect(Number(keys.rows[0]!.n)).toBe(2);
  expect(await nextValue()).toBe(3);
});

it('deja el evento de estado, la auditoría y el outbox', async () => {
  const id = await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
  const events = await db.query('SELECT previous_state, new_state FROM state_events WHERE document_id = $1', [id]);
  expect(events.rows).toEqual([{ previous_state: null, new_state: 'RESERVED' }]);
  const audit = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM audit_events WHERE action = 'INVOICE_RESERVED' AND entity_id = $1 AND tenant_id = $2",
    [id, s.tenant],
  );
  expect(Number(audit.rows[0]!.n)).toBe(1);
  const outbox = await db.query<{ event_type: string; payload: Record<string, unknown>; dispatched_at: unknown }>(
    'SELECT event_type, payload, dispatched_at FROM outbox_events WHERE aggregate_id = $1',
    [id],
  );
  expect(outbox.rows).toHaveLength(1);
  expect(outbox.rows[0]!.event_type).toBe('DOCUMENT_RESERVED');
  expect(outbox.rows[0]!.dispatched_at).toBeNull();
  expect(outbox.rows[0]!.payload).toEqual({ documentId: id });
});

it('el auditor no emite', async () => {
  const res = await send(await memberToken(http(), db, s.tenant, 'AUDITOR'), invoiceJson(s, '1', '11.50')).expect(403);
  expect(res.body.errorCode).toBe('ROLE_FORBIDDEN');
  expect(await documentCount()).toBe(0);
});

it('exige la cabecera Idempotency-Key', async () => {
  const missing = await invoiceRequest(http(), s.owner, invoiceJson(s, '1', '11.50')).expect(400);
  expect(missing.body).toMatchObject({
    errorCode: 'IDEMPOTENCY_KEY_REQUIRED',
    detail: 'La emisión requiere la cabecera Idempotency-Key',
  });
  for (const invalid of ['con espacios', 'x'.repeat(101), 'ñ']) {
    const res = await http()
      .post('/api/v1/invoices')
      .set('Authorization', `Bearer ${s.owner}`)
      // supertest no admite texto no ASCII en una cabecera: se manda en latin1, como lo leería Tomcat.
      .set('Idempotency-Key', Buffer.from(invalid, 'utf8').toString('latin1'))
      .send(invoiceJson(s, '1', '11.50'))
      .expect(400);
    expect(res.body).toMatchObject({
      errorCode: 'IDEMPOTENCY_KEY_INVALID',
      detail: 'La cabecera Idempotency-Key admite hasta 100 caracteres: letras, dígitos y . _ : -',
    });
  }
  expect(await documentCount()).toBe(0);
});

it('la línea puede cambiar el precio y el descuento', async () => {
  // 3 x 8.50 - 5.50 = 20.00; IVA 15 % = 3.00
  const id = await issueInvoice(
    http(),
    s.owner,
    invoiceBody(s, s.customer, [invoiceLine(s.product, '3', '8.50', '5.50')], '23.00'),
  );
  expect((await lines(id))[0]).toMatchObject({ unit_price: '8.500000', discount: '5.50' });
  expect(await document(id)).toMatchObject({ subtotal: '20.00', total_discount: '5.50', total: '23.00' });
});

it('tarifas mezcladas dan un total de impuesto por tarifa', async () => {
  const exempt = await createProduct(http(), s.owner, 'LIB-001', '7.00', '0');
  const id = await issueInvoice(
    http(),
    s.owner,
    invoiceBody(s, s.customer, [invoiceLine(s.product, '1'), invoiceLine(exempt, '2')], '25.50'),
  );
  const t = await taxes(id);
  expect(t).toHaveLength(2);
  expect(t[0]).toMatchObject({ rate_code: '0', base: '14.00' });
  expect(t[1]).toMatchObject({ rate_code: '4', amount: '1.50' });
  const l = await lines(id);
  expect(l).toHaveLength(2);
  expect(l[1]!.main_code).toBe('LIB-001');
  expect((await document(id)).total).toBe('25.50');
});

it('la copia sobrevive a cambios posteriores del catálogo', async () => {
  const id = await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
  await db.query("UPDATE customers SET name = 'Otro Nombre', id_number = '0912345678' WHERE id = $1", [s.customer]);
  await db.query("UPDATE products SET name = 'Otro producto', unit_price = 99, iva_rate_code = '0' WHERE id = $1", [
    s.product,
  ]);
  expect(await document(id)).toMatchObject({
    customer_name: 'María Pérez',
    customer_id_number: '1712345678',
    total: '11.50',
  });
  expect((await lines(id))[0]).toMatchObject({ description: 'Servicio de consultoría', unit_price: '10.000000' });
});

it('rechaza una fecha de emisión futura', async () => {
  const res = await send(s.owner, { ...invoiceJson(s, '1', '11.50'), issueDate: plusDays(today(), 1) }).expect(422);
  expect(res.body).toMatchObject({
    errorCode: 'INVALID_ISSUE_DATE',
    detail: 'La fecha de emisión no puede ser futura',
  });
  expect(await documentCount()).toBe(0);
});

it('rechaza una fecha anterior a la del último comprobante', async () => {
  await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
  const res = await send(s.owner, { ...invoiceJson(s, '1', '11.50'), issueDate: plusDays(today(), -1) }).expect(422);
  expect(res.body.errorCode).toBe('INVALID_ISSUE_DATE');
  expect(await documentCount()).toBe(1);
  expect(await nextValue()).toBe(2);
});

it('admite una fecha pasada en un punto sin uso', async () => {
  const yesterday = plusDays(today(), -1);
  const id = await issueInvoice(http(), s.owner, { ...invoiceJson(s, '1', '11.50'), issueDate: yesterday });
  expect((await document(id)).issue_date).toBe(yesterday);
});

it('una fecha anterior al año 1 no tiene forma de pago vigente, como en Java', async () => {
  // -800000 días de época es un LocalDate del año -220: PostgreSQL no lo lee como texto ISO.
  const body = JSON.stringify(invoiceJson(s, '1', '11.50')).replace('"lines"', '"issueDate":-800000,"lines"');
  const res = await send(s.owner, body).expect(422);
  expect(res.body.errorCode).toBe('PAYMENT_METHOD_UNKNOWN');
  expect(await documentCount()).toBe(0);
});

it('rechaza otra moneda', async () => {
  const res = await send(s.owner, { ...invoiceJson(s, '1', '11.50'), currency: 'EUR' }).expect(422);
  expect(res.body).toMatchObject({ errorCode: 'UNSUPPORTED_CURRENCY', detail: 'Solo se emiten comprobantes en USD' });
});

it('rechaza una forma de pago desconocida', async () => {
  const body = invoiceJson(s, '1', '11.50');
  body.payments = [{ methodCode: '99', amount: '11.50' }];
  const res = await send(s.owner, body).expect(422);
  expect(res.body.errorCode).toBe('PAYMENT_METHOD_UNKNOWN');
});

it('pagos que no suman el total no gastan secuencial', async () => {
  await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
  for (const amount of ['11.49', '11.51', '100']) {
    const res = await send(s.owner, invoiceJson(s, '1', amount)).expect(422);
    expect(res.body).toMatchObject({
      errorCode: 'PAYMENTS_MISMATCH',
      detail: 'La suma de los pagos no coincide con el total del comprobante',
    });
  }
  expect(await documentCount()).toBe(1);
  expect(await nextValue()).toBe(2);
  const outbox = await db.query<{ n: string }>('SELECT count(*) AS n FROM outbox_events WHERE tenant_id = $1', [
    s.tenant,
  ]);
  expect(Number(outbox.rows[0]!.n)).toBe(1);
});

it('los pagos se pueden repartir', async () => {
  const body = invoiceJson(s, '2', '20.00');
  (body.payments as unknown[]).push({ methodCode: '01', amount: '3.00' });
  const id = await issueInvoice(http(), s.owner, body);
  expect(await payments(id)).toEqual([
    { method_code: '20', amount: '20.00' },
    { method_code: '01', amount: '3.00' },
  ]);
});

it('a consumidor final no se factura más de 50', async () => {
  const finalConsumer = await createCustomer(http(), s.owner, '07', '9999999999999');
  const book = await createProduct(http(), s.owner, 'LIB-001', '50.00', '0');
  await issueInvoice(http(), s.owner, invoiceBody(s, finalConsumer, [invoiceLine(book, '1')], '50.00'));
  const res = await send(s.owner, invoiceBody(s, finalConsumer, [invoiceLine(book, '1', '50.01')], '50.01')).expect(422);
  expect(res.body).toMatchObject({
    errorCode: 'FINAL_CONSUMER_LIMIT_EXCEEDED',
    detail: 'Una venta a consumidor final no puede superar el monto máximo; identifique al adquirente',
  });
  // El mismo importe a un cliente identificado sí se puede facturar.
  await issueInvoice(http(), s.owner, invoiceBody(s, s.customer, [invoiceLine(book, '1', '50.01')], '50.01'));
});

it('rechaza líneas inválidas', async () => {
  const zero = await send(s.owner, invoiceJson(s, '0', '0')).expect(422);
  expect(zero.body).toMatchObject({ errorCode: 'INVALID_LINE', detail: 'La cantidad debe ser mayor que cero' });
  const discount = await send(
    s.owner,
    invoiceBody(s, s.customer, [invoiceLine(s.product, '1', undefined, '10.01')], '0'),
  ).expect(422);
  expect(discount.body).toMatchObject({
    errorCode: 'INVALID_LINE',
    detail: 'El descuento no puede superar el importe de la línea',
  });
  const empty = await send(s.owner, invoiceBody(s, s.customer, [], '0')).expect(400);
  expect(empty.body.errorCode).toBe('VALIDATION_FAILED');
  const many = Array.from({ length: 501 }, () => invoiceLine(s.product, '1'));
  const tooMany = await send(s.owner, invoiceBody(s, s.customer, many, '5761.50')).expect(400);
  expect(tooMany.body.errorCode).toBe('VALIDATION_FAILED');
  for (const quantity of ['-1', '1.1234567', '1e2', '']) {
    const res = await send(s.owner, invoiceJson(s, quantity, '11.50')).expect(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  }
  expect(await documentCount()).toBe(0);
});

it('rechaza elementos nulos en líneas y pagos', async () => {
  const nullLine = invoiceBody(s, s.customer, [null], '11.50');
  const nullPayment = { ...invoiceJson(s, '1', '11.50'), payments: [null] };
  for (const body of [nullLine, nullPayment]) {
    const res = await send(s.owner, body).expect(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  }
  expect(await documentCount()).toBe(0);
});

it('rechaza importes que el comprobante no puede guardar', async () => {
  const huge = invoiceLine(s.product, '2', '999999999999');
  const first = await send(s.owner, invoiceBody(s, s.customer, [huge], '999999999999')).expect(422);
  expect(first.body).toMatchObject({
    errorCode: 'AMOUNT_TOO_LARGE',
    detail: 'Los importes del comprobante superan el máximo admitido',
  });
  const discounted = invoiceLine(s.product, '1', '999999999999', '999999999999.00');
  const second = await send(s.owner, invoiceBody(s, s.customer, [discounted, discounted], '0')).expect(422);
  expect(second.body.errorCode).toBe('AMOUNT_TOO_LARGE');
  expect(await documentCount()).toBe(0);
  expect(await nextValue()).toBeNull();
});

it('rechaza un plazo sin su unidad y una unidad sin plazo', async () => {
  for (const extra of [{ term: '30' }, { timeUnit: 'dias' }]) {
    const body = invoiceJson(s, '1', '11.50');
    body.payments = [{ methodCode: '20', amount: '11.50', ...extra }];
    const res = await send(s.owner, body).expect(422);
    expect(res.body).toMatchObject({
      errorCode: 'INVALID_PAYMENT_TERM',
      detail: 'El plazo de una forma de pago lleva su unidad de tiempo',
    });
  }
  expect(await documentCount()).toBe(0);
});

it('rechaza un pago en cero junto a uno con valor', async () => {
  const body = invoiceJson(s, '1', '11.50');
  (body.payments as unknown[]).push({ methodCode: '01', amount: '0' });
  const res = await send(s.owner, body).expect(422);
  expect(res.body).toMatchObject({
    errorCode: 'INVALID_PAYMENT',
    detail: 'Un pago no puede ser cero si el comprobante tiene valor',
  });
  expect(await documentCount()).toBe(0);
});

it('una factura con todo descontado suma cero', async () => {
  const id = await issueInvoice(
    http(),
    s.owner,
    invoiceBody(s, s.customer, [invoiceLine(s.product, '1', undefined, '10.00')], '0'),
  );
  expect((await document(id)).total).toBe('0.00');
  expect(await payments(id)).toEqual([{ method_code: '20', amount: '0.00' }]);
});

it('las referencias desconocidas no existen', async () => {
  const random = randomUUID();
  const bodies = [
    { ...invoiceJson(s, '1', '11.50'), taxpayerId: random },
    { ...invoiceJson(s, '1', '11.50'), establishmentCode: '009' },
    { ...invoiceJson(s, '1', '11.50'), emissionPointCode: '009' },
    { ...invoiceJson(s, '1', '11.50'), customerId: random },
    invoiceBody(s, s.customer, [invoiceLine(random, '1')], '11.50'),
  ];
  for (const body of bodies) {
    const res = await send(s.owner, body).expect(404);
    expect(res.body).toMatchObject({ errorCode: 'NOT_FOUND', detail: 'Recurso no encontrado' });
  }
  expect(await documentCount()).toBe(0);
  expect(await nextValue()).toBeNull();
});

it('un punto de emisión deshabilitado no emite', async () => {
  await db.query('UPDATE emission_points SET enabled = false WHERE id = $1', [s.point]);
  const res = await send(s.owner, invoiceJson(s, '1', '11.50')).expect(422);
  expect(res.body).toMatchObject({
    errorCode: 'EMISSION_POINT_DISABLED',
    detail: 'El punto de emisión está deshabilitado',
  });
});

it('una factura con XML inválido es 422 y no deja rastro', async () => {
  // La API de clientes no admite saltos de línea, pero la base sí: el XSD de la factura no los acepta.
  await db.query("UPDATE customers SET name = E'María\\nPérez' WHERE tenant_id = $1", [s.tenant]);
  const before = await documentCount();
  const sequenceBefore = await nextValue();
  const res = await send(s.owner, invoiceJson(s, '1', '11.50')).expect(422);
  expect(res.body.errorCode).toBe('DOCUMENT_XML_INVALID');
  expect(await documentCount()).toBe(before);
  expect(await nextValue()).toBe(sequenceBefore);
});

describe('como e3.json', () => {
  it('una cantidad o un importe como número JSON valen con el texto enviado', async () => {
    // "quantity": 2 es la cantidad "2"; 2.50 y 123456789012.123456 conservan sus dígitos.
    const two = JSON.stringify(invoiceJson(s, '1', '23.00')).replace('"quantity":"1"', '"quantity":2');
    const id = await issueInvoice(http(), s.owner, two);
    expect((await lines(id))[0]!.quantity).toBe('2.000000');
    const half = JSON.stringify(invoiceJson(s, '1', '12.08')).replace('"amount":"12.08"', '"amount":2.50');
    const res = await send(s.owner, half).expect(422);
    expect(res.body.errorCode).toBe('PAYMENTS_MISMATCH');
    const big = JSON.stringify(invoiceJson(s, '1', '11.50')).replace('"quantity":"1"', '"quantity":123456789012.123456');
    expect((await send(s.owner, big).expect(422)).body.errorCode).toBe('AMOUNT_TOO_LARGE');
    const exponent = JSON.stringify(invoiceJson(s, '1', '11.50')).replace('"quantity":"1"', '"quantity":1e2');
    const invalid = await send(s.owner, exponent).expect(400);
    expect(invalid.body.errors).toEqual([
      { field: 'lines[0].quantity', message: 'must match "[0-9]{1,12}(\\.[0-9]{1,6})?"' },
    ]);
    const padded = await issueInvoice(http(), s.owner, { ...invoiceJson(s, '007', '80.50') });
    expect((await lines(padded))[0]!.quantity).toBe('7.000000');
  });

  it('las propiedades desconocidas se ignoran, también tenantId', async () => {
    const body = invoiceJson(s, '1', '11.50');
    const id = await issueInvoice(http(), s.owner, {
      ...body,
      tenantId: randomUUID(),
      extra: true,
      lines: [{ ...invoiceLine(s.product, '1'), extra: 1 }],
      payments: [{ methodCode: '20', amount: '11.50', extra: 'x' }],
    });
    const row = await db.query<{ tenant_id: string }>('SELECT tenant_id FROM fiscal_documents WHERE id = $1', [id]);
    expect(row.rows[0]!.tenant_id).toBe(s.tenant);
  });

  it('el cuerpo inválido gana a la cabecera ausente o inválida', async () => {
    for (const key of [undefined, 'con espacio']) {
      const res = await invoiceRequest(http(), s.owner, {}, key).expect(400);
      expect(res.body.errorCode).toBe('VALIDATION_FAILED');
    }
  });

  it('una clave de 100 caracteres vale y una de espacios falta', async () => {
    await send(s.owner, invoiceJson(s, '1', '11.50')).expect(202);
    await invoiceRequest(http(), s.owner, invoiceJson(s, '1', '11.50'), 'k'.repeat(100)).expect(202);
    const blank = await invoiceRequest(http(), s.owner, invoiceJson(s, '1', '11.50'), '   ').expect(400);
    expect(blank.body.errorCode).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const slash = await invoiceRequest(http(), s.owner, invoiceJson(s, '1', '11.50'), 'a/b').expect(400);
    expect(slash.body.errorCode).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('un plazo y su unidad se guardan, la unidad recortada', async () => {
    const body = invoiceJson(s, '1', '11.50');
    body.payments = [{ methodCode: '20', amount: '11.50', term: '30', timeUnit: ' dias ' }];
    const id = await issueInvoice(http(), s.owner, body);
    const res = await db.query('SELECT term, time_unit FROM fiscal_document_payments WHERE document_id = $1', [id]);
    expect(res.rows).toEqual([{ term: '30.00', time_unit: 'dias' }]);
  });
});
