import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { FiscalDocumentRepository } from '../../../src/billing/fiscal-document.repository.js';
import { invoiceXmlData } from '../../../src/billing/invoice-kind.js';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import type { InvoiceXmlData } from '../../../src/xml/invoice-xml.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  bearer,
  billingScenario,
  createCustomer,
  createEmissionPoint,
  createEstablishment,
  createProduct,
  invoiceJson,
  issueInvoice,
  newOwner,
  randomRuc,
  taxpayerJson,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de IssuerSnapshotIT: el XML se generará de lo que el documento guardó al emitirse, no de las tablas vivas.
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let kysely: Kysely<DB>;
const documents = new FiscalDocumentRepository();

beforeAll(async () => {
  stack = await startStack();
  // RUC del proveedor de las pruebas de Java (einvoice.provider.ruc).
  testApp = await startTestApp(stack, { EINVOICE_PROVIDER_RUC: '1790099999001' });
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  kysely = testApp.app.get<Kysely<DB>>(DATABASE);
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});

const http = () => testApp.http;

/** Sobre y cuerpo congelados, juntos como los consume el generador del XML de la factura. */
async function frozen(tenant: string, id: string): Promise<InvoiceXmlData> {
  const envelope = await documents.envelope(kysely, tenant, id);
  if (envelope === null) throw new Error('el comprobante no existe');
  return invoiceXmlData(envelope, await documents.invoiceBody(kysely, tenant, id));
}

it('el comprobante congela los datos del emisor', async () => {
  const s = await billingScenario(http(), db);
  const id = await issueInvoice(http(), s.owner, invoiceJson(s, '2', '23.00'));

  await db.query(
    `UPDATE taxpayers SET legal_name = 'Otra S.A.', trade_name = 'Otra', head_office_address = 'Cuenca',
      accounting_required = true, special_taxpayer_code = '999', withholding_agent_code = '7',
      rimpe_regime = 'EMPRENDEDOR' WHERE id = $1`,
    [s.taxpayer],
  );
  await db.query("UPDATE establishments SET address = 'Loja' WHERE id = $1", [s.establishment]);

  const data = await frozen(s.tenant, id);
  expect(data).toMatchObject({
    issuerLegalName: 'Comercial Andina S.A.',
    issuerTradeName: 'Andina',
    headOfficeAddress: 'Av. Amazonas N34-12, Quito',
    establishmentAddress: 'Av. 10 de Agosto, Quito',
    accountingRequired: false,
    specialTaxpayerCode: null,
    withholdingAgentCode: null,
    rimpeRegime: 'NONE',
    issuerRuc: s.ruc,
    environment: '1',
    establishmentCode: '001',
    emissionPointCode: '001',
    sequence: 1,
    customerIdType: '05',
    customerIdNumber: '1712345678',
    customerName: 'María Pérez',
    customerAddress: 'Av. República, Quito',
  });
  expect(data.accessKey).toHaveLength(49);
  expect(data.subtotal.toFixed(2)).toBe('20.00');
  expect(data.total.toFixed(2)).toBe('23.00');
  expect(data.taxes).toHaveLength(1);
  expect(data.lines).toHaveLength(1);
  expect(data.lines[0]!.quantity.toFixed(0)).toBe('2');
  expect(data.payments).toHaveLength(1);
  expect(await documents.envelope(kysely, randomUUID(), id)).toBeNull();
});

it('el comprobante congela los teléfonos y el plazo del pago', async () => {
  const s = await billingScenario(http(), db);
  const patched = await http()
    .patch(`/api/v1/taxpayers/${s.taxpayer}`)
    .set('Authorization', bearer(s.owner))
    .send({ phone: '(02) 245-6789' })
    .expect(200);
  expect(patched.body.phone).toBe('(02) 245-6789');
  const body = invoiceJson(s, '2', '23.00');
  body.payments = [{ methodCode: '20', amount: '23.00', term: '30', timeUnit: 'dias' }];
  const id = await issueInvoice(http(), s.owner, body);

  await db.query("UPDATE taxpayers SET phone = '0999999999' WHERE id = $1", [s.taxpayer]);
  await db.query("UPDATE customers SET phone = '0988888888' WHERE id = $1", [s.customer]);

  const envelope = (await documents.envelope(kysely, s.tenant, id))!;
  expect(envelope.issuer.phone).toBe('(02) 245-6789');
  expect(envelope.recipient.phone).toBe('022345678');
  const payment = (await frozen(s.tenant, id)).payments[0]!;
  expect(payment.term?.toFixed(0)).toBe('30');
  expect(payment.timeUnit).toBe('dias');
});

it('el comprobante congela las leyendas fiscales y el RUC del proveedor', async () => {
  const { token: owner, tenant } = await newOwner(http());
  const created = await http()
    .post('/api/v1/taxpayers')
    .set('Authorization', bearer(owner))
    .send({
      ...taxpayerJson(randomRuc()),
      accountingRequired: true,
      specialTaxpayerCode: '5368',
      withholdingAgentCode: '1',
      rimpeRegime: 'EMPRENDEDOR',
    })
    .expect(201);
  const taxpayer = (created.body as { id: string }).id;
  await createEmissionPoint(http(), owner, await createEstablishment(http(), owner, taxpayer, '001'), '001');
  const customer = await createCustomer(http(), owner, '05', '1712345678');
  const product = await createProduct(http(), owner, 'SRV-001', '10.00', '4');
  const s = { owner, tenant, taxpayer, ruc: '', establishment: '', point: '', customer, product };

  const id = await issueInvoice(http(), owner, invoiceJson(s, '1', '11.50'));

  const data = await frozen(tenant, id);
  expect(data).toMatchObject({
    accountingRequired: true,
    specialTaxpayerCode: '5368',
    withholdingAgentCode: '1',
    rimpeRegime: 'EMPRENDEDOR',
    // RUC del proveedor configurado para las pruebas (EINVOICE_PROVIDER_RUC).
    providerRuc: '1790099999001',
  });
});
