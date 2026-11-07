import pg from 'pg';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  bearer,
  billingScenario,
  creditLine,
  creditNoteJson,
  debitNoteJson,
  invoiceJson,
  issueCreditNote,
  issueDebitNote,
  issueInvoice,
  manualCreditNoteJson,
  setState,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

/*
 * Traducción de NotesViewIT (creditNoteViewShowsModifiedDocumentReasonAndLines,
 * debitNoteViewShowsReasonsAndPayments, invoiceViewShowsCreditedTotal): la vista del comprobante
 * (GET /documents/{id}) de las notas y de la factura acreditada.
 */
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;

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

const http = () => testApp.http;
const view = (id: string, token: string) =>
  http().get(`/api/v1/documents/${id}`).set('Authorization', bearer(token));

it('creditNoteViewShowsModifiedDocumentReasonAndLines', async () => {
  const s = await billingScenario(http(), db);
  const invoice = await issueInvoice(http(), s.owner, invoiceJson(s, '2', '23.00'));
  await setState(db, invoice, 'AUTHORIZED');
  const note = await issueCreditNote(http(), s.owner, creditNoteJson(s, invoice, [creditLine(1, '1')]));

  const res = await view(note, s.owner).expect(200);
  const body = res.body as Record<string, unknown>;
  expect(body).toMatchObject({
    documentType: '04',
    modifiedDocument: { code: '01', number: '001-001-000000001', documentId: invoice },
    reason: 'Devolución de mercadería',
    reasons: null,
    creditedTotal: null,
    payments: [],
    total: '11.50',
  });
  expect((body.modifiedDocument as { issueDate: string }).issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(body.lines).toEqual([
    {
      lineNo: 1,
      invoiceLineNo: 1,
      productId: s.product,
      mainCode: 'SRV-001',
      description: 'Servicio de consultoría',
      quantity: '1.000000',
      unitPrice: '10.000000',
      discount: '0.00',
      subtotal: '10.00',
      taxCode: '2',
      taxRateCode: '4',
      taxRate: '15.00',
      taxAmount: '1.50',
    },
  ]);
  expect(body.taxes).toEqual([{ taxCode: '2', rateCode: '4', rate: '15.00', base: '10.00', amount: '1.50' }]);
});

it('la vista de una nota sobre una factura escrita a mano no enlaza documento ni línea', async () => {
  const s = await billingScenario(http(), db);
  const note = await issueCreditNote(http(), s.owner, manualCreditNoteJson(s, '001-002-000000123', '2024-01-15', '1'));

  const body = (await view(note, s.owner).expect(200)).body as Record<string, unknown>;
  expect(body.modifiedDocument).toEqual({
    code: '01',
    number: '001-002-000000123',
    issueDate: '2024-01-15',
    documentId: null,
  });
  expect(body.lines).toMatchObject([{ lineNo: 1, invoiceLineNo: null, productId: s.product }]);
});

it('debitNoteViewShowsReasonsAndPayments', async () => {
  const s = await billingScenario(http(), db);
  const invoice = await issueInvoice(http(), s.owner, invoiceJson(s, '2', '23.00'));
  await setState(db, invoice, 'AUTHORIZED');
  const note = await issueDebitNote(http(), s.owner, debitNoteJson(s, invoice));

  const body = (await view(note, s.owner).expect(200)).body as Record<string, unknown>;
  expect(body).toMatchObject({
    documentType: '05',
    modifiedDocument: { code: '01', number: '001-001-000000001', documentId: invoice },
    reason: null,
    lines: [],
    creditedTotal: null,
    subtotal: '15.00',
    totalDiscount: '0.00',
    totalTax: '1.50',
    total: '16.50',
  });
  expect(body.reasons).toEqual([
    { reason: 'Intereses por mora', value: '10.00', taxRateCode: '4', taxRate: '15.00', taxAmount: '1.50' },
    { reason: 'Gastos de cobranza', value: '5.00', taxRateCode: '0', taxRate: '0.00', taxAmount: '0.00' },
  ]);
  expect(body.payments).toEqual([{ methodCode: '20', amount: '16.50', term: null, timeUnit: null }]);
  expect(body.taxes).toEqual([
    { taxCode: '2', rateCode: '0', rate: '0.00', base: '5.00', amount: '0.00' },
    { taxCode: '2', rateCode: '4', rate: '15.00', base: '10.00', amount: '1.50' },
  ]);
});

it('invoiceViewShowsCreditedTotal', async () => {
  const s = await billingScenario(http(), db);
  const invoice = await issueInvoice(http(), s.owner, invoiceJson(s, '2', '23.00'));
  await setState(db, invoice, 'AUTHORIZED');

  const before = (await view(invoice, s.owner)).body as Record<string, unknown>;
  expect(before).toMatchObject({ creditedTotal: '0.00', modifiedDocument: null, reason: null });
  expect((before.lines as Array<{ invoiceLineNo: unknown }>)[0]!.invoiceLineNo).toBeNull();

  await issueCreditNote(http(), s.owner, creditNoteJson(s, invoice, [creditLine(1, '1')]));

  expect(((await view(invoice, s.owner)).body as { creditedTotal: string }).creditedTotal).toBe('11.50');
});
