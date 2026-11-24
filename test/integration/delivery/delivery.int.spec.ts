import type { DeliveryConfig } from '../../../src/delivery/delivery-config.js';
import type { DeliveryMailer } from '../../../src/delivery/delivery-mailer.js';
import { DeliveryRepository } from '../../../src/delivery/delivery.repository.js';
import { DeliveryService } from '../../../src/delivery/delivery.service.js';
import { DocumentArchiver } from '../../../src/delivery/document-archiver.js';
import { DocumentKinds } from '../../../src/billing/document-kind.js';
import { FiscalDocumentRepository } from '../../../src/billing/fiscal-document.repository.js';
import { WEBHOOK_RECORDER } from '../../../src/orchestration/webhook-recorder.js';
import { ArtifactStore } from '../../../src/storage/artifact-store.js';
import { type AuthorizedInvoice, DeliveryHarness, SENDER } from '../../support/delivery-scenario.js';
import { invoiceJson, issueInvoice, newOwner } from '../../support/scenario.js';
import { SmtpReply } from '../../support/scripted-smtp.js';

// Traducción de delivery/DeliveryIT.java: entrega por correo del comprobante autorizado, contra un SMTP simulado.
let h: DeliveryHarness;
let invoice: AuthorizedInvoice;

beforeAll(async () => {
  h = await DeliveryHarness.start();
}, 300_000);
afterAll(async () => {
  await h?.stop();
});
beforeEach(async () => {
  invoice = await h.authorizedInvoice();
});

const config = (enabled: boolean): DeliveryConfig => ({
  email: { enabled, from: enabled ? SENDER : null },
  retryBackoffMs: 60_000,
  retryMaxBackoffMs: 6 * 3_600_000,
  retryMaxAttempts: 8,
  sendLeaseMs: 120_000,
  maxPerDocument: 10,
});

const service = (enabled: boolean, mailer: DeliveryMailer | null) => {
  const { app } = h.testApp;
  return new DeliveryService(
    h.kysely,
    app.get(DocumentArchiver),
    app.get(FiscalDocumentRepository),
    app.get(DeliveryRepository),
    app.get(ArtifactStore),
    config(enabled),
    mailer,
    app.get(WEBHOOK_RECORDER),
    app.get(DocumentKinds),
  );
};

it('authorizedInvoiceIsEmailedWithRideAndXml', async () => {
  expect(await invoice.process()).toBe(1);

  const received = await h.smtp.messages(invoice.email);
  expect(received).toHaveLength(1);
  const message = received[0]!;
  expect(message.from!.value).toEqual([{ address: SENDER, name: 'Andina' }]);
  expect(Array.isArray(message.to) ? [] : message.to!.value.map((to) => to.address)).toEqual([invoice.email]);
  expect(message.cc).toBeUndefined();
  expect(message.subject).toMatch(/^Factura 001-001-.* de Andina$/);
  for (const part of [invoice.key, '23.00', 'María Pérez']) expect(message.text).toContain(part);
  expect(message.attachments).toHaveLength(2);
  expect(message.attachments[0]!.filename).toMatch(/^factura-001-001-.*\.pdf$/);
  expect(message.attachments[0]!.content.equals((await invoice.artifact('RIDE_PDF'))!)).toBe(true);
  expect(message.attachments[1]!.filename).toBe(`${invoice.key}.xml`);
  expect(message.attachments[1]!.content.equals((await invoice.artifact('XML_AUTHORIZED'))!)).toBe(true);

  const row = await invoice.delivery();
  expect(row).toMatchObject({
    status: 'SENT',
    channel: 'EMAIL',
    recipient: invoice.email,
    attempt_count: 1,
    requested_by: null,
    next_attempt_at: null,
    sending_since: null,
    last_error: null,
    tenant_id: invoice.s.tenant,
  });
  expect(row.sent_at).not.toBeNull();
  expect(row.provider_message_id).toBeTruthy();
  expect(
    (await h.db.query('SELECT state FROM fiscal_documents WHERE id = $1', [invoice.document])).rows[0],
  ).toEqual({ state: 'AUTHORIZED' });
});

it('processingAgainSendsNothing', async () => {
  await invoice.process();

  expect(await invoice.process()).toBe(0);

  expect(h.smtp.raw(invoice.email)).toHaveLength(1);
  expect(await invoice.rows()).toHaveLength(1);
});

it('concurrentProcessingSendsOneEmail', async () => {
  h.smtp.onRecipient(invoice.email, SmtpReply.delayed(500, SmtpReply.accept()));

  const sent = await Promise.all(Array.from({ length: 4 }, () => invoice.process()));

  expect(sent.reduce((sum, n) => sum + n, 0)).toBe(1);
  expect(h.smtp.raw(invoice.email)).toHaveLength(1);
  expect(await invoice.delivery()).toMatchObject({ status: 'SENT', attempt_count: 1 });
});

it('customerWithoutEmailIsArchivedButNotEmailed', async () => {
  const other = await h.scenario(null);
  const document = await issueInvoice(h.http, other.owner, invoiceJson(other, '1', '11.50'));
  await h.pipeline.advance(other.tenant, document);

  expect(await h.deliveries.process(other.tenant, document)).toBe(0);

  expect((await h.db.query('SELECT 1 FROM deliveries WHERE document_id = $1', [document])).rowCount).toBe(0);
  const kinds = await h.db.query('SELECT kind FROM document_artifacts WHERE document_id = $1', [document]);
  expect(kinds.rows.map((row: { kind: string }) => row.kind)).toEqual(
    expect.arrayContaining(['RIDE_PDF', 'XML_AUTHORIZED']),
  );
});

it('emailDisabledArchivesWithoutCreatingDeliveries', async () => {
  // Con el correo desactivado no existe ningún remitente.
  expect(await invoice.process(service(false, null))).toBe(0);

  expect(await invoice.rows()).toEqual([]);
  expect(h.smtp.raw(invoice.email)).toEqual([]);
  expect(await invoice.artifact('RIDE_PDF')).not.toBeNull();
});

it('enabledWithoutAMailerFailsAtStartup', () => {
  // Sin remitente real, cada envío fallaría en silencio: mejor no arrancar.
  expect(() => service(true, null)).toThrow('einvoice.delivery.email.enabled');
});

it('unauthorizedDocumentIsNeitherArchivedNorEmailed', async () => {
  const { s } = invoice;
  const reserved = await issueInvoice(h.http, s.owner, invoiceJson(s, '1', '11.50'));

  expect(await h.deliveries.process(s.tenant, reserved)).toBe(0);

  expect((await h.db.query('SELECT 1 FROM deliveries WHERE document_id = $1', [reserved])).rowCount).toBe(0);
  expect((await h.db.query('SELECT 1 FROM document_artifacts WHERE document_id = $1', [reserved])).rowCount).toBe(0);
  expect(h.smtp.raw(invoice.email)).toEqual([]);
});

it('foreignDocumentIsNotFound', async () => {
  const other = (await newOwner(h.http)).tenant;

  await expect(h.deliveries.process(other, invoice.document)).rejects.toMatchObject({ status: 404 });

  expect(await invoice.rows()).toEqual([]);
  expect(h.smtp.raw(invoice.email)).toEqual([]);
});
