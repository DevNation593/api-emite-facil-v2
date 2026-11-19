import type { Kysely } from 'kysely';
import pg from 'pg';
import { OutboxWriter } from '../../../src/billing/outbox-writer.js';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { DueDocumentScheduler } from '../../../src/orchestration/due-document-scheduler.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { billingScenario, invoiceJson, issueInvoice } from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de orchestration/DueDocumentSchedulerIT.java: los documentos con un intento vencido vuelven a la
// cola a través del outbox.
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let scheduler: DueDocumentScheduler;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack, { EINVOICE_WORKER_ENABLED: 'false' });
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  scheduler = new DueDocumentScheduler(testApp.app.get<Kysely<DB>>(DATABASE), new OutboxWriter());
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});

const dueEvents = async (document: string) =>
  Number(
    (
      await db.query(
        "SELECT count(*) AS n FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DOCUMENT_DUE'",
        [document],
      )
    ).rows[0].n,
  );
const nextAttemptAt = async (document: string) =>
  (await db.query('SELECT next_attempt_at FROM fiscal_documents WHERE id = $1', [document])).rows[0]
    .next_attempt_at as Date | null;
const minutesFromNow = (date: Date) => (date.getTime() - Date.now()) / 60_000;

it('dueDocumentGetsAnEventAndALease', async () => {
  const s = await billingScenario(testApp.http, db);
  const document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'));
  await db.query("UPDATE fiscal_documents SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [document]);

  expect(await scheduler.enqueueDue()).toBeGreaterThanOrEqual(1);

  expect(await dueEvents(document)).toBe(1);
  const event = await db.query(
    "SELECT tenant_id::text || '|' || (dispatched_at IS NULL) AS e, payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DOCUMENT_DUE'",
    [document],
  );
  expect(event.rows[0]).toEqual({ e: `${s.tenant}|true`, payload: { documentId: document } });
  // Si el mensaje se perdiera, el documento volvería a salir al vencer este plazo (5 minutos).
  const lease = minutesFromNow((await nextAttemptAt(document))!);
  expect(lease).toBeGreaterThan(4);
  expect(lease).toBeLessThan(6);

  await scheduler.enqueueDue();
  expect(await dueEvents(document)).toBe(1);
});

it('freshInvoiceIsScheduledAsASafetyNet', async () => {
  const s = await billingScenario(testApp.http, db);

  const document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'));

  // Si el evento de emisión se pierde o acaba en la cola de mensajes muertos, el planificador la retoma.
  const lease = minutesFromNow((await nextAttemptAt(document))!);
  expect(lease).toBeGreaterThan(4);
  expect(lease).toBeLessThan(6);
  expect((await db.query('SELECT attempt_count FROM fiscal_documents WHERE id = $1', [document])).rows[0]).toEqual({
    attempt_count: 0,
  });
});

it('futureAndUnscheduledDocumentsAreIgnored', async () => {
  const s = await billingScenario(testApp.http, db);
  const later = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'));
  const unscheduled = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'));
  await db.query("UPDATE fiscal_documents SET next_attempt_at = now() + interval '1 hour' WHERE id = $1", [later]);
  await db.query('UPDATE fiscal_documents SET next_attempt_at = NULL WHERE id = $1', [unscheduled]);

  await scheduler.enqueueDue();

  expect(await dueEvents(later)).toBe(0);
  expect(await dueEvents(unscheduled)).toBe(0);
  expect(await nextAttemptAt(unscheduled)).toBeNull();
});

it('dos planificadores a la vez no encolan el mismo documento dos veces', async () => {
  const s = await billingScenario(testApp.http, db);
  const documents = await Promise.all(
    Array.from({ length: 5 }, () => issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'))),
  );
  await db.query("UPDATE fiscal_documents SET next_attempt_at = now() - interval '1 second' WHERE id = ANY($1)", [
    documents,
  ]);

  await Promise.all([scheduler.enqueueDue(), scheduler.enqueueDue(), scheduler.enqueueDue()]);

  for (const document of documents) expect(await dueEvents(document)).toBe(1);
});
