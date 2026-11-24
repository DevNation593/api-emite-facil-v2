import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { FiscalDocumentRepository } from '../../../src/billing/fiscal-document.repository.js';
import { InvoiceKind } from '../../../src/billing/invoice-kind.js';
import { ecuadorOffsetDateTime } from '../../../src/common/java-time.js';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { DocumentPipeline } from '../../../src/orchestration/document-pipeline.js';
import { DOCUMENT_TYPES } from '../../../src/xml/document-type.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { pdfText } from '../../support/pdf-inspect.js';
import {
  accessKeyOf,
  billingScenario,
  invoiceJson,
  issueInvoice,
  newOwner,
  uploadTestCertificate,
  type BillingScenario,
} from '../../support/scenario.js';
import { AUTHORIZATION_DATE } from '../../support/sri-soap-samples.js';
import { SriStub, sriTestEnv } from '../../support/sri-stub.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de delivery/RideDataIT.java: el sobre del RIDE leído del comprobante autorizado.
let stack: StackHandle;
let sri: SriStub;
let testApp: TestApp;
let db: pg.Client;
let kysely: Kysely<DB>;
let pipeline: DocumentPipeline;
let documents: FiscalDocumentRepository;

beforeAll(async () => {
  stack = await startStack();
  sri = await SriStub.start();
  testApp = await startTestApp(stack, sriTestEnv(sri));
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  kysely = testApp.app.get(DATABASE);
  pipeline = testApp.app.get(DocumentPipeline);
  documents = testApp.app.get(FiscalDocumentRepository);
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await sri?.close();
  await stack?.stop();
});

let s: BillingScenario;
let document: string;
beforeEach(async () => {
  s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));
});

it('authorizedInvoiceHasRideEnvelope', async () => {
  expect(await pipeline.advance(s.tenant, document)).toBe('AUTHORIZED');
  const key = await accessKeyOf(db, document);

  const ride = (await documents.rideEnvelope(kysely, s.tenant, document))!;
  const kind = testApp.app.get(InvoiceKind);
  const body = await kind.loadContent(kysely, s.tenant, document);

  expect(ride.authorizationNumber).toBe(key);
  expect(ecuadorOffsetDateTime(ride.authorizedAt!)).toBe(AUTHORIZATION_DATE);
  expect(ride.envelope.type).toBe(DOCUMENT_TYPES.INVOICE);
  expect(ride.envelope.recipient.email).toBe('cliente@example.test');
  expect((await documents.paymentMethodNames(kysely)).get('20')).toBe('OTROS CON UTILIZACIÓN DEL SISTEMA FINANCIERO');
  expect(ride.envelope.accessKey).toBe(key);
  expect(ride.envelope.issuer.ruc).toBe(s.ruc);
  expect(ride.envelope.totals!.total.toFixed(2)).toBe('23.00');
  expect(ride.envelope.totals!.totalTax).not.toBeNull();
  expect(ride.envelope.modified).toBeNull();
  expect(body.lines).toHaveLength(1);
  // Con el sobre y el cuerpo el XML y el RIDE se generan.
  expect(kind.buildXml(ride.envelope, body).toString('utf8')).toContain(key);
  expect(await pdfText(await kind.buildRide(kysely, ride, body))).toContain(key);
});

it('unauthorizedOrForeignDocumentHasNone', async () => {
  expect(await documents.rideEnvelope(kysely, s.tenant, document)).toBeNull();
  expect(await documents.envelope(kysely, s.tenant, document)).not.toBeNull();

  await pipeline.advance(s.tenant, document);
  const other = (await newOwner(testApp.http)).tenant;

  expect(await documents.rideEnvelope(kysely, s.tenant, document)).not.toBeNull();
  expect(await documents.rideEnvelope(kysely, s.tenant, randomUUID())).toBeNull();
  expect(await documents.rideEnvelope(kysely, other, document)).toBeNull();
  expect(await documents.envelope(kysely, other, document)).toBeNull();
});
