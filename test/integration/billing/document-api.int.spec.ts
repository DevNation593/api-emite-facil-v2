import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { BigDecimal } from '../../../src/common/big-decimal.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { insertDocument, newUser, type Scenario } from '../../support/billing-data.js';
import {
  bearer,
  type BillingScenario,
  billingScenario,
  invoiceJson,
  issueInvoice,
  memberToken,
  setState,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

/*
 * Traducción de los casos de InvoiceApiIT sobre GET /documents (listsDocumentsOfTheTenant,
 * listFiltersByDocumentType, unknownDocumentTypeIs400, remissionGuideHasNullTotal), más los
 * parámetros y el detalle que fija test/golden/http/e3.json.
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
const get = (path: string, token: string = s.owner) => http().get(path).set('Authorization', bearer(token));
const list = (query: string, token?: string) => get(`/api/v1/documents${query}`, token);
const DOCUMENTS = '/api/v1/documents/';

async function insert(sequence: number, options: Parameters<typeof insertDocument>[3]): Promise<string> {
  const scenario: Scenario = { ...s, user: await newUser(db) };
  return insertDocument(db, scenario, sequence, options);
}

describe('GET /documents', () => {
  it('lista los comprobantes de la empresa, el más reciente primero', async () => {
    await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
    await issueInvoice(http(), s.owner, invoiceJson(s, '2', '23.00'));
    const last = await issueInvoice(http(), s.owner, invoiceJson(s, '3', '34.50'));
    const res = await list('?size=2').expect(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.items[0]).toEqual({
      id: last,
      documentType: '01',
      state: 'RESERVED',
      number: '001-001-000000003',
      issueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      customerName: 'María Pérez',
      total: '34.50',
    });
    expect(Object.keys(res.body)).toEqual(['items', 'page', 'size', 'total']);
    expect(res.body.items[0].lines).toBeUndefined();
    await get(DOCUMENTS + randomUUID()).expect(404);
  });

  it('filtra por tipo de comprobante', async () => {
    await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
    const credit = await insert(50, { type: '04', total: BigDecimal.of('5.00'), content: '{}' });
    const filtered = await list('?documentType=04').expect(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items[0]).toMatchObject({ id: credit, documentType: '04' });
    const all = await list('').expect(200);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.total).toBe(2);
  });

  it('un tipo de comprobante desconocido es 400', async () => {
    const res = await list('?documentType=02').expect(400);
    expect(res.body.errorCode).toBe('MALFORMED_REQUEST');
  });

  it('la guía de remisión no tiene total', async () => {
    const guide = await insert(60, { type: '06', total: null, content: '{}' });
    const listed = await list('?documentType=06').expect(200);
    expect(listed.body.items[0].id).toBe(guide);
    expect(listed.body.items[0].total).toBeNull();
    const detail = await get(DOCUMENTS + guide).expect(200);
    expect(detail.body).toMatchObject({
      documentType: '06',
      subtotal: null,
      totalDiscount: null,
      totalTax: null,
      total: null,
      lines: [],
      payments: [],
      taxes: [],
      creditedTotal: null,
    });
  });

  it('ordena por creación, secuencial descendente e id', async () => {
    const first = await insert(1, {});
    const second = await insert(2, {});
    await db.query('UPDATE fiscal_documents SET created_at = $1 WHERE id IN ($2, $3)', [
      '2026-01-01 00:00:00+00',
      first,
      second,
    ]);
    const res = await list('').expect(200);
    expect((res.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([second, first]);
  });

  describe('parámetros como e3.json', () => {
    const malformed = 'La petición está mal formada';
    const range = 'page debe estar entre 0 y 100000 y size entre 1 y 100';

    it.each([
      ['page=abc', malformed],
      ['page=1.5', malformed],
      ['page=99999999999', malformed],
      ['size=x', malformed],
      ['page=-1', range],
      ['page=100001', range],
      ['size=0', range],
      ['size=101', range],
      ['page=-1&documentType=02', range],
      ['documentType=02&page=-1', range],
      ['size=101&documentType=ab', range],
      ['page=abc&documentType=ab', malformed],
    ])('%s es 400', async (query, detail) => {
      const res = await list(`?${query}`).expect(400);
      expect(res.body).toMatchObject({ errorCode: 'MALFORMED_REQUEST', detail });
    });

    it.each(['1', '02', 'ab', '', '01&documentType=04', '%2001', 'a', '001'])(
      'documentType=%s es un tipo desconocido',
      async (value) => {
        const res = await list(`?documentType=${value}`).expect(400);
        expect(res.body).toMatchObject({ errorCode: 'MALFORMED_REQUEST', detail: 'Tipo de comprobante desconocido' });
      },
    );

    it('los códigos conocidos sin comprobantes dan una página vacía', async () => {
      for (const code of ['05', '06', '07']) {
        const res = await list(`?documentType=${code}`).expect(200);
        expect(res.body).toEqual({ items: [], page: 0, size: 20, total: 0 });
      }
    });

    it('page y size vacíos o repetidos', async () => {
      for (let i = 1; i <= 3; i++) await insert(i, {});
      expect((await list('?page=&size=').expect(200)).body).toMatchObject({ page: 0, size: 20, total: 3 });
      expect((await list('?page=1&page=2&size=1').expect(200)).body).toMatchObject({ page: 1, size: 1, total: 3 });
      expect((await list('?page=%202&size=1').expect(200)).body).toMatchObject({ page: 2, size: 1 });
      expect((await list('?page=0x1&size=1').expect(200)).body).toMatchObject({ page: 1, size: 1 });
      expect((await list('?page=100000').expect(200)).body.items).toEqual([]);
    });

    it('sin credenciales es 401', async () => {
      await http().get('/api/v1/documents').expect(401);
      await http().get(DOCUMENTS + randomUUID()).expect(401);
    });
  });
});

describe('GET /documents/{id}', () => {
  it('el detalle de una factura sale con las propiedades y escalas de Java', async () => {
    const id = await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
    const res = await get(DOCUMENTS + id).expect(200);
    expect(Object.keys(res.body)).toEqual([
      'id', 'documentType', 'state', 'environment', 'taxpayerId', 'number', 'sequence', 'accessKey', 'issueDate',
      'currency', 'customer', 'subtotal', 'totalDiscount', 'taxes', 'totalTax', 'total', 'lines', 'payments',
      'authorizationNumber', 'authorizedAt', 'customerId', 'replacesDocumentId', 'replacedByDocumentId',
      'modifiedDocument', 'reason', 'reasons', 'creditedTotal',
    ]);
    expect(res.body).toMatchObject({
      id,
      documentType: '01',
      state: 'RESERVED',
      environment: '1',
      taxpayerId: s.taxpayer,
      number: '001-001-000000001',
      sequence: '000000001',
      currency: 'USD',
      customer: { idType: '05', idNumber: '1712345678', name: 'María Pérez' },
      subtotal: '10.00',
      totalDiscount: '0.00',
      taxes: [{ taxCode: '2', rateCode: '4', rate: '15.00', base: '10.00', amount: '1.50' }],
      totalTax: '1.50',
      total: '11.50',
      lines: [
        {
          lineNo: 1,
          invoiceLineNo: null,
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
      ],
      payments: [{ methodCode: '20', amount: '11.50', term: null, timeUnit: null }],
      authorizationNumber: null,
      authorizedAt: null,
      customerId: s.customer,
      replacesDocumentId: null,
      replacedByDocumentId: null,
      modifiedDocument: null,
      reason: null,
      reasons: null,
      creditedTotal: '0.00',
    });
  });

  it('acepta el id en mayúsculas y rechaza lo mal formado', async () => {
    const id = await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
    expect((await get(DOCUMENTS + id.toUpperCase()).expect(200)).body.id).toBe(id);
    expect((await get(DOCUMENTS + 'x').expect(400)).body.detail).toBe('La petición está mal formada');
    await get(DOCUMENTS + '1-2-3-4-5').expect(404);
  });

  it('un auditor consulta sin control de rol', async () => {
    const id = await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
    const auditor = await memberToken(http(), db, s.tenant, 'AUDITOR');
    await list('', auditor).expect(200);
    await get(DOCUMENTS + id, auditor).expect(200);
  });

  it('authorizedAt sale como lo escribe Jackson: 0, 3 o 6 decimales', async () => {
    const id = await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
    const authorize = (at: string) =>
      db.query(
        `UPDATE fiscal_documents SET state = 'AUTHORIZED', authorization_number = $1, authorized_at = $2 WHERE id = $3`,
        ['1'.repeat(49), at, id],
      );
    const authorizedAt = async () => (await get(DOCUMENTS + id).expect(200)).body.authorizedAt as string;

    await authorize('2026-11-02 10:15:30.123456-05');
    expect(await authorizedAt()).toBe('2026-11-02T15:15:30.123456Z');
    await authorize('2026-11-02 10:15:30-05');
    expect(await authorizedAt()).toBe('2026-11-02T15:15:30Z');
    await authorize('2026-11-02 10:15:30.120-05');
    expect(await authorizedAt()).toBe('2026-11-02T15:15:30.120Z');
    expect((await get(DOCUMENTS + id).expect(200)).body).toMatchObject({
      state: 'AUTHORIZED',
      authorizationNumber: '1'.repeat(49),
    });
  });

  it('creditedTotal suma las notas de crédito vigentes de la factura', async () => {
    const id = await issueInvoice(http(), s.owner, invoiceJson(s, '1', '11.50'));
    const credit = await insert(70, { type: '04', total: BigDecimal.of('5.00'), content: '{}' });
    await db.query(
      `UPDATE fiscal_documents SET modified_document_id = $1, modified_doc_code = '01',
        modified_doc_number = '001-001-000000001', modified_doc_date = DATE '2026-10-10' WHERE id = $2`,
      [id, credit],
    );
    expect((await get(DOCUMENTS + id).expect(200)).body.creditedTotal).toBe('5.00');
    await setState(db, credit, 'RETURNED');
    expect((await get(DOCUMENTS + id).expect(200)).body.creditedTotal).toBe('0.00');
  });
});
