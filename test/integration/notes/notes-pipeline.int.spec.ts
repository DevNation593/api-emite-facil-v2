import { randomUUID } from 'node:crypto';
import type { ParsedMail } from 'mailparser';
import pg from 'pg';
import { startStack, type StackHandle } from '../../support/containers.js';
import { deliveryTestEnv } from '../../support/delivery-scenario.js';
import { ScriptedSmtp } from '../../support/scripted-smtp.js';
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
// encendido, SRI simulado) hasta AUTHORIZED, con su RIDE y su correo.
const PATIENCE_MS = 40_000;
let stack: StackHandle;
let sri: SriStub;
let smtp: ScriptedSmtp;
let testApp: TestApp;
let db: pg.Client;

beforeAll(async () => {
  stack = await startStack();
  sri = await SriStub.start();
  smtp = await ScriptedSmtp.start();
  testApp = await startTestApp(stack, {
    ...sriTestEnv(sri),
    ...deliveryTestEnv(smtp),
    EINVOICE_WORKER_ENABLED: 'true',
    EINVOICE_WORKER_POLL_INTERVAL_MS: '200',
  });
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await smtp?.close();
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

/** El correo de la nota (el de la factura llegó antes). */
async function mailWithSubject(email: string, prefix: string): Promise<ParsedMail> {
  return vi.waitFor(
    async () => {
      const found = (await smtp.messages(email)).find((message) => message.subject?.startsWith(prefix));
      if (found === undefined) throw new Error(`aún no llegó ${prefix}`);
      return found;
    },
    { timeout: PATIENCE_MS, interval: 200 },
  );
}

/** El correo lleva el RIDE y el XML autorizado, y el RIDE se archiva antes de enviarlo. */
async function expectDelivered(s: BillingScenario, note: string, email: string, subject: string, stem: string) {
  const message = await mailWithSubject(email, subject);
  expect(message.subject!.startsWith(`${subject}001-001-`)).toBe(true);
  expect(message.attachments[0]!.filename).toMatch(new RegExp(`^${stem}-001-001-\\d{9}\\.pdf$`));
  const ride = await testApp.http
    .get(`/api/v1/documents/${note}/artifacts/ride`)
    .set('Authorization', bearer(s.owner))
    .responseType('blob');
  expect(ride.status).toBe(200);
  expect(message.attachments[0]!.content.equals(ride.body as Buffer)).toBe(true);
}

/** Factura autorizada de 2 x 10.00 + IVA 15 % = 23.00, con el cliente con ese correo. */
async function authorizedInvoice(s: BillingScenario, email: string): Promise<string> {
  await db.query('UPDATE customers SET email = $1 WHERE id = $2', [email, s.customer]);
  const invoice = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));
  await awaitState(s.owner, invoice, 'AUTHORIZED');
  return invoice;
}

async function signedXml(id: string): Promise<string> {
  const row = await db.query("SELECT convert_from(content, 'UTF8') AS xml FROM document_artifacts WHERE document_id = $1 AND kind = 'XML_SIGNED'", [id]);
  return (row.rows[0] as { xml: string }).xml;
}

it('creditNoteEndsAuthorizedWithRideAndMail', async () => {
  const s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  const email = `c-${randomUUID()}@cliente.test`;
  const invoice = await authorizedInvoice(s, email);

  const note = await issueCreditNote(testApp.http, s.owner, creditNoteJson(s, invoice, [creditLine(1, '1')]));

  await awaitState(s.owner, note, 'AUTHORIZED');
  expect(await signedXml(note)).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"[^>]*\?><notaCredito id="comprobante"/);
  await expectDelivered(s, note, email, 'Nota de crédito ', 'nota-credito');
}, 90_000);

it('debitNoteEndsAuthorizedWithRideAndMail', async () => {
  const s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  const email = `c-${randomUUID()}@cliente.test`;
  const invoice = await authorizedInvoice(s, email);

  const note = await issueDebitNote(testApp.http, s.owner, debitNoteJson(s, invoice));

  await awaitState(s.owner, note, 'AUTHORIZED');
  expect(await signedXml(note)).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"[^>]*\?><notaDebito id="comprobante"/);
  await expectDelivered(s, note, email, 'Nota de débito ', 'nota-debito');
}, 90_000);
