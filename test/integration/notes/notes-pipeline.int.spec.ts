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
  uploadTestCertificate,
  type BillingScenario,
} from '../../support/scenario.js';
import { SriStub, sriTestEnv } from '../../support/sri-stub.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// De notes/NotesPipelineIT.java: las notas de crédito y de débito recorren el pipeline completo (worker
// encendido, SRI simulado) hasta AUTHORIZED. El RIDE y el correo llegan en E5.
const PATIENCE_MS = 40_000;
let stack: StackHandle;
let sri: SriStub;
let testApp: TestApp;
let db: pg.Client;

beforeAll(async () => {
  stack = await startStack();
  sri = await SriStub.start();
  testApp = await startTestApp(stack, {
    ...sriTestEnv(sri),
    EINVOICE_WORKER_ENABLED: 'true',
    EINVOICE_WORKER_POLL_INTERVAL_MS: '200',
  });
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await sri?.close();
  await stack?.stop();
});

async function awaitState(token: string, id: string, state: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const res = await testApp.http.get(`/api/v1/documents/${id}`).set('Authorization', bearer(token));
      expect((res.body as { state: string }).state).toBe(state);
    },
    { timeout: PATIENCE_MS, interval: 200 },
  );
}

/** Factura autorizada de 2 x 10.00 + IVA 15 % = 23.00. */
async function authorizedInvoice(s: BillingScenario): Promise<string> {
  const invoice = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));
  await awaitState(s.owner, invoice, 'AUTHORIZED');
  return invoice;
}

async function signedXml(id: string): Promise<string> {
  const row = await db.query("SELECT convert_from(content, 'UTF8') AS xml FROM document_artifacts WHERE document_id = $1 AND kind = 'XML_SIGNED'", [id]);
  return (row.rows[0] as { xml: string }).xml;
}

it('creditNoteEndsAuthorized', async () => {
  const s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  const invoice = await authorizedInvoice(s);

  const note = await issueCreditNote(testApp.http, s.owner, creditNoteJson(s, invoice, [creditLine(1, '1')]));

  await awaitState(s.owner, note, 'AUTHORIZED');
  expect(await signedXml(note)).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"[^>]*\?><notaCredito id="comprobante"/);
}, 90_000);

it('debitNoteEndsAuthorized', async () => {
  const s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  const invoice = await authorizedInvoice(s);

  const note = await issueDebitNote(testApp.http, s.owner, debitNoteJson(s, invoice));

  await awaitState(s.owner, note, 'AUTHORIZED');
  expect(await signedXml(note)).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"[^>]*\?><notaDebito id="comprobante"/);
}, 90_000);
