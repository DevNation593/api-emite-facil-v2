import pg from 'pg';
import { DocumentPipeline } from '../../../src/orchestration/document-pipeline.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  bearer,
  billingScenario,
  invoiceJson,
  issueInvoice,
  memberToken,
  uploadTestCertificate,
  type BillingScenario,
} from '../../support/scenario.js';
import { SriStub, sriTestEnv } from '../../support/sri-stub.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de orchestration/DocumentRetryApiIT.java: reintento manual de un comprobante que quedó a medio camino.
let stack: StackHandle;
let sri: SriStub;
let testApp: TestApp;
let db: pg.Client;
let pipeline: DocumentPipeline;

beforeAll(async () => {
  stack = await startStack();
  sri = await SriStub.start();
  testApp = await startTestApp(stack, sriTestEnv(sri));
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  pipeline = testApp.app.get(DocumentPipeline);
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
  document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));
  expect(await pipeline.advance(s.tenant, document)).toBe('SIGNATURE_FAILED');
});

const retry = (token: string, id = document) =>
  testApp.http.post(`/api/v1/documents/${id}/retry`).set('Authorization', bearer(token));
const one = async <T>(sqlText: string, ...params: unknown[]): Promise<T> =>
  Object.values((await db.query(sqlText, params)).rows[0] as Record<string, unknown>)[0] as T;
const retryEvents = async () =>
  Number(
    await one(
      "SELECT count(*) FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DOCUMENT_RETRY_REQUESTED' AND dispatched_at IS NULL",
      document,
    ),
  );
const nextAttemptAt = () => one<Date | null>('SELECT next_attempt_at FROM fiscal_documents WHERE id = $1', document);

it('retrySchedulesTheDocumentAndLeavesAnEvent', async () => {
  await db.query('UPDATE fiscal_documents SET attempt_count = 3 WHERE id = $1', [document]);

  const res = await retry(s.owner).expect(202);
  expect(res.body).toEqual({ id: document, state: 'SIGNATURE_FAILED' });
  expect(Object.keys(res.body as object)).toEqual(['id', 'state']);

  expect((await nextAttemptAt())!.getTime()).toBeLessThanOrEqual(Date.now());
  expect(await one('SELECT attempt_count FROM fiscal_documents WHERE id = $1', document)).toBe(0);
  expect(await retryEvents()).toBe(1);
  const audit = await db.query(
    "SELECT metadata FROM audit_events WHERE entity_id = $1 AND action = 'DOCUMENT_RETRY_REQUESTED' AND tenant_id = $2",
    [document, s.tenant],
  );
  expect(audit.rows).toEqual([{ metadata: { state: 'SIGNATURE_FAILED' } }]);
});

it('retryAfterUploadingTheCertificateGetsItAuthorized', async () => {
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  await retry(s.owner).expect(202);

  // Lo que hará el worker al recibir el evento.
  expect(await pipeline.advance(s.tenant, document)).toBe('AUTHORIZED');
});

it('retryAfterUploadingTheCertificateGetsItAuthorized, con el worker', async () => {
  const worker = await startTestApp(stack, {
    ...sriTestEnv(sri),
    EINVOICE_WORKER_ENABLED: 'true',
    EINVOICE_WORKER_POLL_INTERVAL_MS: '200',
  });
  try {
    await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
    await retry(s.owner).expect(202);
    await vi.waitFor(
      async () => expect(await one('SELECT state FROM fiscal_documents WHERE id = $1', document)).toBe('AUTHORIZED'),
      { timeout: 40_000, interval: 200 },
    );
  } finally {
    await worker.close();
  }
}, 90_000);

it('retryThatFixesNothingDoesNotStayScheduled', async () => {
  await retry(s.owner).expect(202);

  // Sigue sin certificado: el worker lo intenta y vuelve a quedar sin firmar.
  expect(await pipeline.advance(s.tenant, document)).toBe('SIGNATURE_FAILED');

  expect(await nextAttemptAt()).toBeNull();
});

it('billerCanRetry', async () => {
  await retry(await memberToken(testApp.http, db, s.tenant, 'BILLER')).expect(202);
});

it('terminalDocumentIsNotRetryable', async () => {
  for (const state of ['AUTHORIZED', 'RETURNED', 'NOT_AUTHORIZED', 'XSD_INVALID']) {
    await db.query('UPDATE fiscal_documents SET state = $1 WHERE id = $2', [state, document]);

    const res = await retry(s.owner).expect(409);
    expect(res.body).toMatchObject({
      errorCode: 'DOCUMENT_NOT_RETRYABLE',
      detail: 'El comprobante está en un estado que no admite reintento',
    });
  }
  expect(await retryEvents()).toBe(0);
  expect(await nextAttemptAt()).toBeNull();
});

it('auditorCannotRetry', async () => {
  await retry(await memberToken(testApp.http, db, s.tenant, 'AUDITOR')).expect(403);
  expect(await retryEvents()).toBe(0);
});

it('foreignDocumentIsNotFound', async () => {
  const other = await billingScenario(testApp.http, db);

  await retry(other.owner).expect(404);
  expect(await retryEvents()).toBe(0);
  expect(await one('SELECT count(*)::int FROM audit_events WHERE entity_id = $1 AND tenant_id = $2', document, other.tenant)).toBe(0);
});

it('exhaustedDocumentIsRevived', async () => {
  await db.query(
    "UPDATE fiscal_documents SET state = 'RECEIVED', attempt_count = 5, next_attempt_at = NULL WHERE id = $1",
    [document],
  );

  const res = await retry(s.owner).expect(202);
  expect((res.body as { state: string }).state).toBe('RECEIVED');

  expect(
    await one("SELECT attempt_count || '|' || (next_attempt_at IS NOT NULL) FROM fiscal_documents WHERE id = $1", document),
  ).toBe('0|true');
});
