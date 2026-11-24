import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import { DocumentKinds } from '../../../src/billing/document-kind.js';
import { FiscalDocumentRepository } from '../../../src/billing/fiscal-document.repository.js';
import { APP_CONFIG, type AppConfig } from '../../../src/config/app-config.js';
import type { DB } from '../../../src/database/schema.js';
import type { DeliveryMailer } from '../../../src/delivery/delivery-mailer.js';
import { DeliveryRepository } from '../../../src/delivery/delivery.repository.js';
import { DELIVERY_MAILER, DeliveryService } from '../../../src/delivery/delivery.service.js';
import { DocumentArchiver } from '../../../src/delivery/document-archiver.js';
import { NoWebhooks, type WebhookRecorder } from '../../../src/orchestration/webhook-recorder.js';
import { ArtifactStore } from '../../../src/storage/artifact-store.js';
import { type AuthorizedInvoice, DeliveryHarness } from '../../support/delivery-scenario.js';
import { SmtpReply } from '../../support/scripted-smtp.js';

// Traducción de delivery/DeliveryRetryIT.java: reintentos con espera creciente, rechazo definitivo y envíos que se
// quedaron a medias.
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

const TEMPORARY = () => SmtpReply.failData(451, '4.3.0 Intente más tarde');
const properties = () => h.testApp.app.get<symbol, AppConfig>(APP_CONFIG).delivery;

function service(
  overrides: { mailer?: DeliveryMailer; webhooks?: WebhookRecorder; repository?: DeliveryRepository } = {},
): DeliveryService {
  const { app } = h.testApp;
  return new DeliveryService(
    h.kysely,
    app.get(DocumentArchiver),
    app.get(FiscalDocumentRepository),
    overrides.repository ?? app.get(DeliveryRepository),
    app.get(ArtifactStore),
    properties(),
    overrides.mailer ?? app.get<symbol, DeliveryMailer>(DELIVERY_MAILER),
    overrides.webhooks ?? new NoWebhooks(),
    app.get(DocumentKinds),
  );
}

const update = (set: string, ...values: unknown[]) =>
  h.db.query(`UPDATE deliveries SET ${set} WHERE document_id = $1`, [invoice.document, ...values]);

/** Da por cumplida la espera del reintento, como si hubiera pasado el tiempo. */
const waitIsOver = () => update("retry_after = now() - interval '1 second'");

it('temporaryFailureIsRetriedLater', async () => {
  h.smtp.onRecipient(invoice.email, TEMPORARY(), SmtpReply.accept());

  expect(await invoice.process()).toBe(0);

  const failed = await invoice.delivery();
  expect(failed).toMatchObject({ status: 'PENDING', attempt_count: 1, sent_at: null });
  expect(failed.last_error).toBe('SMTP 451: 451 4.3.0 Intente más tarde');
  expect(failed.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
  expect(h.smtp.raw(invoice.email)).toEqual([]);

  // Mientras dura la espera no se reintenta, aunque llegue otro evento del mismo comprobante.
  expect(await invoice.process()).toBe(0);
  expect(await invoice.delivery()).toMatchObject({ status: 'PENDING', attempt_count: 1 });
  expect(h.smtp.raw(invoice.email)).toEqual([]);

  // Lo que hará el worker cuando el planificador lo devuelva a la cola, cumplida la espera.
  await waitIsOver();
  expect(await invoice.process()).toBe(1);

  expect(await invoice.delivery()).toMatchObject({
    status: 'SENT',
    attempt_count: 2,
    next_attempt_at: null,
    last_error: null,
  });
  expect(h.smtp.raw(invoice.email)).toHaveLength(1);
});

it('droppedConnectionIsRetried', async () => {
  h.smtp.onRecipient(invoice.email, SmtpReply.dropConnection(), SmtpReply.accept());

  expect(await invoice.process()).toBe(0);
  expect(await invoice.delivery()).toMatchObject({ status: 'PENDING', last_error: 'SMTP -1: [EOF]' });

  await waitIsOver();
  expect(await invoice.process()).toBe(1);
  expect(h.smtp.raw(invoice.email)).toHaveLength(1);
});

it('rejectedRecipientFailsForGood', async () => {
  h.smtp.onRecipient(invoice.email, SmtpReply.rejectRecipient(550, '5.1.1 El buzón no existe'));

  expect(await invoice.process()).toBe(0);

  const row = await invoice.delivery();
  expect(row).toMatchObject({ status: 'FAILED', attempt_count: 1, next_attempt_at: null });
  expect(row.last_error).toContain('550');

  // Un rechazo definitivo no se vuelve a intentar solo.
  expect(await invoice.process()).toBe(0);
  expect(await invoice.delivery()).toMatchObject({ attempt_count: 1 });
  expect(h.smtp.raw(invoice.email)).toEqual([]);
});

it('retriesAreExhausted', async () => {
  h.smtp.onRecipient(invoice.email, TEMPORARY());
  await invoice.process();
  const max = properties().retryMaxAttempts;
  await update('attempt_count = $2', max - 1);
  await waitIsOver();

  expect(await invoice.process()).toBe(0);

  expect(await invoice.delivery()).toMatchObject({ status: 'FAILED', attempt_count: max, next_attempt_at: null });
});

it('attemptsOverTheCapFailWithoutSending', async () => {
  h.smtp.onRecipient(invoice.email, TEMPORARY(), SmtpReply.accept());
  await invoice.process();
  // Una entrega que ya superó el máximo (por ejemplo, tras fallos que nadie pudo anotar).
  await update('attempt_count = $2', properties().retryMaxAttempts);
  await waitIsOver();

  expect(await invoice.process()).toBe(0);

  expect(await invoice.delivery()).toMatchObject({
    status: 'FAILED',
    next_attempt_at: null,
    last_error: 'Se agotaron los intentos de envío',
  });
  expect(h.smtp.raw(invoice.email)).toEqual([]);
});

it('aFailureToAnnounceTheDeliveryDoesNotUnmarkASentEmail', async () => {
  // El correo ya salió: si anotar el aviso falla, no puede volver a salir por eso.
  const failing = new NoWebhooks();
  failing.delivered = () => Promise.reject(new Error('no se pudo anotar el aviso'));
  const broken = service({ webhooks: failing });

  expect(await invoice.process(broken)).toBe(1);

  expect(await invoice.delivery()).toMatchObject({ status: 'SENT' });
  expect(await invoice.process(broken)).toBe(0);
  expect(h.smtp.raw(invoice.email)).toHaveLength(1);
});

it('el aviso se anota una sola vez por entrega, con el envío', async () => {
  const announced: string[] = [];
  const recorder = new NoWebhooks();
  recorder.delivered = (trx: Transaction<DB>, tenantId: string, documentId: string) => {
    if (!trx.isTransaction) throw new Error('fuera de la transacción');
    announced.push(`${tenantId}|${documentId}`);
    return Promise.resolve();
  };

  await invoice.process(service({ webhooks: recorder }));
  await invoice.process(service({ webhooks: recorder }));

  expect(announced).toEqual([`${invoice.s.tenant}|${invoice.document}`]);
});

it('unexpectedMailerFailureIsRecordedNotLeftSending', async () => {
  const mailer: DeliveryMailer = {
    send: () => Promise.reject(new TypeError('fallo inesperado con datos internos smtp.interno:25')),
  };

  expect(await invoice.process(service({ mailer }))).toBe(0);

  // Queda anotado como un fallo reintentable, no "enviando" para siempre.
  const row = await invoice.delivery();
  expect(row).toMatchObject({ status: 'PENDING', attempt_count: 1, last_error: 'Fallo inesperado: TypeError' });
  expect(row.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
});

it('invalidFrozenAddressFailsWithoutContactingTheServer', async () => {
  const group = `grupo:a-${randomUUID()}@x.test,b@y.test;`;
  await h.db.query('UPDATE fiscal_documents SET customer_email = $1 WHERE id = $2', [group, invoice.document]);
  const before = h.smtp.connections();

  expect(await invoice.process()).toBe(0);

  expect(await invoice.delivery()).toMatchObject({
    status: 'FAILED',
    next_attempt_at: null,
    last_error: 'Dirección de correo no válida',
  });
  expect(h.smtp.connections()).toBe(before);
});

it('abandonedSendIsTakenOverAfterTheLease', async () => {
  h.smtp.onRecipient(invoice.email, TEMPORARY(), SmtpReply.accept());
  await invoice.process();

  // Un envío en curso reciente no se toca: otro proceso lo está haciendo.
  await update("status = 'SENDING', sending_since = now()");
  expect(await invoice.process()).toBe(0);
  expect(await invoice.delivery()).toMatchObject({ status: 'SENDING', attempt_count: 1 });
  expect(h.smtp.raw(invoice.email)).toEqual([]);

  // Uno que lleva diez minutos "en curso" murió a medias: se retoma.
  await update("sending_since = now() - interval '10 minutes'");
  expect(await invoice.process()).toBe(1);
  expect(await invoice.delivery()).toMatchObject({ status: 'SENT' });
  expect(h.smtp.raw(invoice.email)).toHaveLength(1);
});

it('un correo aceptado que no se pudo anotar no se repite hasta vencer el plazo de envío', async () => {
  class Unreachable extends DeliveryRepository {
    override markSent(): Promise<boolean> {
      return Promise.reject(new Error('la base no responde'));
    }
  }

  await expect(invoice.process(service({ repository: new Unreachable() }))).rejects.toThrow('la base no responde');

  expect(h.smtp.raw(invoice.email)).toHaveLength(1);
  const row = await invoice.delivery();
  expect(row).toMatchObject({ status: 'SENDING', attempt_count: 1 });
  // Queda programada al vencer el plazo, por si nadie lo anota.
  expect(row.next_attempt_at!.getTime()).toBeGreaterThan(Date.now() + 20_000);
  expect(await invoice.process()).toBe(0);
  expect(h.smtp.raw(invoice.email)).toHaveLength(1);

  // Entrega al menos una vez: pasado el plazo se repite.
  await update("sending_since = now() - interval '31 seconds'");
  expect(await invoice.process()).toBe(1);
  expect(h.smtp.raw(invoice.email)).toHaveLength(2);
  expect(await invoice.delivery()).toMatchObject({ status: 'SENT', attempt_count: 2 });
});

it('supersededAttemptCannotOverwriteTheResult', async () => {
  h.smtp.onRecipient(invoice.email, TEMPORARY());
  await invoice.process();
  await waitIsOver();
  const repository = h.testApp.app.get(DeliveryRepository);
  const db: Kysely<DB> = h.kysely;
  const { id } = await invoice.delivery();
  const lease = properties().sendLeaseMs;
  // El proceso A reserva la entrega (intento 2) y tarda tanto que B la toma (intento 3).
  const attemptA = (await repository.claim(db, id, lease))!.attemptCount;
  expect(await repository.claim(db, id, lease)).toBeNull();
  await update("sending_since = now() - interval '1 hour'");
  const attemptB = (await repository.claim(db, id, lease))!.attemptCount;
  expect(attemptB).toBe(attemptA + 1);

  // A falla tarde: no puede devolverla a pendiente mientras B la tiene.
  await repository.markRetry(db, id, attemptA, 1_000, 'fallo de A');
  expect(await invoice.delivery()).toMatchObject({ status: 'SENDING' });
  expect((await invoice.delivery()).last_error).not.toBe('fallo de A');
  await repository.markFailed(db, id, attemptA, 'fallo de A');
  expect(await invoice.delivery()).toMatchObject({ status: 'SENDING' });

  // Un envío aceptado es un hecho: se anota aunque el intento ya no sea el vigente…
  expect(await repository.markSent(db, id, '<mensaje-de-a@plataforma.test>')).toBe(true);
  expect(await repository.markSent(db, id, '<otro@plataforma.test>')).toBe(false);
  expect(await invoice.delivery()).toMatchObject({ status: 'SENT' });

  // …y un fallo posterior del otro intento no lo deshace.
  await repository.markFailed(db, id, attemptB, 'fallo de B');
  await repository.markRetry(db, id, attemptB, 1_000, 'fallo de B');
  expect(await invoice.delivery()).toMatchObject({
    status: 'SENT',
    provider_message_id: '<mensaje-de-a@plataforma.test>',
    next_attempt_at: null,
  });
});

it('deliveryFailureNeverChangesTheFiscalState', async () => {
  const snapshot = async () =>
    (
      await h.db.query<{ s: string }>(
        `SELECT d.state || '|' || d.version || '|' || d.authorization_number || '|'
           || (SELECT count(*) FROM document_artifacts a WHERE a.document_id = d.id) || '|'
           || (SELECT count(*) FROM state_events e WHERE e.document_id = d.id) AS s
         FROM fiscal_documents d WHERE d.id = $1`,
        [invoice.document],
      )
    ).rows[0]!.s;
  await h.testApp.app.get(DocumentArchiver).archive(invoice.s.tenant, invoice.document);
  const before = await snapshot();
  h.smtp.onRecipient(invoice.email, SmtpReply.rejectRecipient(550, '5.1.1 El buzón no existe'));

  await invoice.process();

  expect(await invoice.delivery()).toMatchObject({ status: 'FAILED' });
  expect(await snapshot()).toBe(before);
});
