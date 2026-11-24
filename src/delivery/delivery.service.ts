import { Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { DocumentKinds } from '../billing/document-kind.js';
import type { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import type { RideEnvelope } from '../billing/ride-envelope.js';
import type { DB } from '../database/schema.js';
import { retryDelayMs } from '../orchestration/retry-policy.js';
import type { WebhookRecorder } from '../orchestration/webhook-recorder.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import { type DeliveryConfig, validAddress } from './delivery-config.js';
import { buildDeliveryEmail } from './delivery-email.js';
import type { DeliveryMailer, MailResult } from './delivery-mailer.js';
import type { DeliveryClaim, DeliveryRepository } from './delivery.repository.js';
import type { DocumentArchiver } from './document-archiver.js';

/** El remitente de los correos de entrega; nulo con el correo desactivado. */
export const DELIVERY_MAILER = Symbol('DELIVERY_MAILER');

const MAX_ERROR = 500;

const errorName = (error: unknown): string => (error instanceof Error ? error.constructor.name : typeof error);

/**
 * Archiva un comprobante autorizado y lo entrega a su receptor, como delivery/DeliveryService.java. La entrega tiene
 * su propio estado: pase lo que pase con el correo, el comprobante sigue autorizado.
 *
 * El envío se hace fuera de toda transacción. La entrega se reserva antes de enviar, de modo que dos procesos no
 * envían la misma; si el proceso muere después de que el servidor aceptó el mensaje y antes de anotarlo, el correo
 * se repite al vencer el plazo de envío (entrega al menos una vez).
 */
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly db: Kysely<DB>,
    private readonly archiver: DocumentArchiver,
    private readonly documents: FiscalDocumentRepository,
    private readonly deliveries: DeliveryRepository,
    private readonly artifacts: ArtifactStore,
    private readonly config: DeliveryConfig,
    private readonly mailer: DeliveryMailer | null,
    private readonly webhooks: WebhookRecorder,
    private readonly kinds: DocumentKinds,
    private readonly random: () => number = Math.random,
  ) {
    if (config.email.enabled && mailer === null) {
      // Sin esto las peticiones de entrega se aceptarían y ningún correo saldría nunca.
      throw new Error(
        'El envío de correo está habilitado (einvoice.delivery.email.enabled)' +
          ' pero no hay con qué enviar: revise la configuración del servidor SMTP',
      );
    }
  }

  /** Archiva el comprobante e intenta sus entregas pendientes. Devuelve cuántos correos envió. */
  async process(tenantId: string, documentId: string): Promise<number> {
    if (!(await this.archiver.archive(tenantId, documentId)) || !this.config.email.enabled) return 0;
    const ride = await this.documents.rideEnvelope(this.db, tenantId, documentId);
    if (ride === null) return 0;
    const customerEmail = ride.envelope.recipient.email;
    if (customerEmail !== null && customerEmail.trim() !== '') {
      await this.deliveries.ensureAutomatic(this.db, tenantId, documentId, customerEmail);
    }
    let sent = 0;
    for (const deliveryId of await this.deliveries.pending(this.db, tenantId, documentId, this.config.sendLeaseMs)) {
      const claim = await this.deliveries.claim(this.db, deliveryId, this.config.sendLeaseMs);
      if (claim !== null && (await this.send(tenantId, documentId, deliveryId, claim, ride))) sent++;
    }
    return sent;
  }

  private async send(
    tenantId: string,
    documentId: string,
    deliveryId: string,
    claim: DeliveryClaim,
    ride: RideEnvelope,
  ): Promise<boolean> {
    const attempt = claim.attemptCount;
    if (attempt > this.config.retryMaxAttempts) {
      await this.deliveries.markFailed(this.db, deliveryId, attempt, 'Se agotaron los intentos de envío');
      return false;
    }
    if (!validAddress(claim.recipient)) {
      // Ni siquiera se contacta al servidor: una dirección que son varias, o que no lo es.
      await this.deliveries.markFailed(this.db, deliveryId, attempt, 'Dirección de correo no válida');
      return false;
    }
    const result = await this.attempt(tenantId, documentId, deliveryId, claim, ride);
    if (result.sent) {
      await this.recordSent(tenantId, documentId, deliveryId, result.messageId);
      return true;
    }
    const error = (result.error ?? 'Fallo sin detalle').slice(0, MAX_ERROR);
    if (result.permanent || attempt >= this.config.retryMaxAttempts) {
      await this.deliveries.markFailed(this.db, deliveryId, attempt, error);
      this.logger.warn(
        `La entrega ${deliveryId} del documento ${documentId} falló definitivamente tras ${attempt} intento(s)`,
      );
    } else {
      const delay = retryDelayMs(attempt, this.config.retryBackoffMs, this.config.retryMaxBackoffMs, this.random());
      await this.deliveries.markRetry(this.db, deliveryId, attempt, delay, error);
    }
    return false;
  }

  private async attempt(
    tenantId: string,
    documentId: string,
    deliveryId: string,
    claim: DeliveryClaim,
    ride: RideEnvelope,
  ): Promise<MailResult> {
    try {
      const pdf = await this.artifacts.find(this.db, tenantId, documentId, 'RIDE_PDF');
      const xml = await this.artifacts.find(this.db, tenantId, documentId, 'XML_AUTHORIZED');
      const kind = this.kinds.find(ride.envelope.type.code);
      if (pdf === null || xml === null || kind === null) {
        throw new Error(`Comprobante autorizado sin artefactos o de un tipo sin implementación: ${documentId}`);
      }
      return await this.mailer!.send(
        buildDeliveryEmail(
          this.config.email.from!,
          ride,
          kind.displayName,
          kind.fileStem,
          claim.recipient,
          pdf.content,
          xml.content,
        ),
      );
    } catch (error) {
      // Un fallo imprevisto no puede dejar la entrega "enviando": se anota y se reintenta como cualquier otro. Solo
      // el tipo va a la entrega; el detalle, al log.
      this.logger.error(
        `Fallo inesperado al enviar la entrega ${deliveryId} del documento ${documentId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return { sent: false, permanent: false, error: `Fallo inesperado: ${errorName(error)}` };
    }
  }

  /** El aviso a los sistemas de la empresa se anota junto con el envío, y una sola vez. */
  private async recordSent(
    tenantId: string,
    documentId: string,
    deliveryId: string,
    messageId: string,
  ): Promise<void> {
    try {
      await this.db.transaction().execute(async (trx) => {
        if (await this.deliveries.markSent(trx, deliveryId, messageId)) {
          await this.webhooks.delivered(trx, tenantId, documentId);
        }
      });
    } catch (error) {
      // El correo ya salió: que no se pueda anotar el aviso no puede hacer que salga otra vez.
      this.logger.error(
        `No se pudo anotar el aviso de la entrega ${deliveryId} del documento ${documentId}: ${errorName(error)}`,
      );
      await this.deliveries.markSent(this.db, deliveryId, messageId);
    }
  }
}
