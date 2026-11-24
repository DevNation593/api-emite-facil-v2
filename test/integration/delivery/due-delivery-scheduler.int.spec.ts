import { DueDeliveryScheduler } from '../../../src/delivery/due-delivery-scheduler.js';
import { type AuthorizedInvoice, DeliveryHarness } from '../../support/delivery-scenario.js';
import { SmtpReply } from '../../support/scripted-smtp.js';

// Traducción de delivery/DueDeliverySchedulerIT.java: las entregas con un intento vencido vuelven a la cola de
// entrega a través del outbox.
let h: DeliveryHarness;
let invoice: AuthorizedInvoice;
let scheduler: DueDeliveryScheduler;

beforeAll(async () => {
  h = await DeliveryHarness.start();
  scheduler = h.testApp.app.get(DueDeliveryScheduler);
}, 300_000);
afterAll(async () => {
  await h?.stop();
});
beforeEach(async () => {
  invoice = await h.authorizedInvoice();
});

const dueEvents = async () =>
  (
    await h.db.query<{ tenant_id: string; payload: unknown; pending: boolean }>(
      `SELECT tenant_id, payload, dispatched_at IS NULL AS pending FROM outbox_events
       WHERE aggregate_id = $1 AND event_type = 'DELIVERY_DUE'`,
      [invoice.document],
    )
  ).rows;

const update = (set: string) => h.db.query(`UPDATE deliveries SET ${set} WHERE document_id = $1`, [invoice.document]);

it('dueDeliveryGetsAnEventAndALease', async () => {
  h.smtp.onRecipient(invoice.email, SmtpReply.failData(451, '4.3.0 Intente más tarde'));
  await invoice.process();
  await update("next_attempt_at = now() - interval '1 second'");

  expect(await scheduler.enqueueDue()).toBeGreaterThanOrEqual(1);

  expect(await dueEvents()).toEqual([
    { tenant_id: invoice.s.tenant, payload: { documentId: invoice.document }, pending: true },
  ]);
  // Si el mensaje se perdiera, la entrega volvería a salir al vencer este plazo (5 minutos).
  const minutes = ((await invoice.delivery()).next_attempt_at!.getTime() - Date.now()) / 60_000;
  expect(minutes).toBeGreaterThan(4);
  expect(minutes).toBeLessThan(6);
  // Sigue pendiente: el planificador solo avisa, no envía.
  expect(await invoice.delivery()).toMatchObject({ status: 'PENDING' });

  await scheduler.enqueueDue();
  expect(await dueEvents()).toHaveLength(1);
});

it('sentFailedAndFutureDeliveriesAreIgnored', async () => {
  // Enviada: nada programado.
  await invoice.process();
  await scheduler.enqueueDue();
  expect(await dueEvents()).toEqual([]);

  // Pendiente pero con el siguiente intento en el futuro.
  await update("status = 'PENDING', next_attempt_at = now() + interval '1 hour'");
  await scheduler.enqueueDue();
  expect(await dueEvents()).toEqual([]);

  // Fallida definitivamente: sin programar.
  await update("status = 'FAILED', next_attempt_at = NULL");
  await scheduler.enqueueDue();
  expect(await dueEvents()).toEqual([]);
});

it('varias entregas vencidas de un comprobante dejan un solo evento', async () => {
  await invoice.process();
  await h.db.query(
    `INSERT INTO deliveries (tenant_id, document_id, channel, recipient, status, next_attempt_at, requested_by)
     SELECT tenant_id, id, 'EMAIL', 'otra@cliente.test', 'PENDING', now() - interval '1 second', created_by
     FROM fiscal_documents, generate_series(1, 3) WHERE id = $1`,
    [invoice.document],
  );

  await scheduler.enqueueDue();

  expect(await dueEvents()).toHaveLength(1);
});

it('dos planificadores a la vez no encolan lo mismo', async () => {
  h.smtp.onRecipient(invoice.email, SmtpReply.failData(451, '4.3.0 Intente más tarde'));
  await invoice.process();
  await update("next_attempt_at = now() - interval '1 second'");

  await Promise.all([scheduler.enqueueDue(), scheduler.enqueueDue(), scheduler.enqueueDue()]);

  expect(await dueEvents()).toHaveLength(1);
});
