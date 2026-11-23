import { Logger } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { FiscalDocumentRepository, ProcessingState } from '../billing/fiscal-document.repository.js';
import type { OutboxWriter } from '../billing/outbox-writer.js';
import { ApiException } from '../common/api-exception.js';
import { REDELIVERY_LEASE_MS } from '../config/app-config.js';
import type { DB } from '../database/schema.js';
import type { SriGateway } from '../sri/http-sri-gateway.js';
import type { SriAttemptLog } from '../sri/sri-attempt-log.js';
import { isEnabled, sendLeaseMs, type SriConfig } from '../sri/sri-config.js';
import { matchesLabel, sriEnvironmentOf, type SriEnvironment } from '../sri/sri-environment.js';
import { hasMessage, type ReceptionResult, type SriMessage } from '../sri/sri-results.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import {
  type DocumentProcessor,
  PENDING_STATES,
  SIGNATURE_FAILED,
  SIGNED,
  XSD_INVALID,
} from './document-processor.js';
import { retryDelayMs } from './retry-policy.js';
import type { WebhookRecorder } from './webhook-recorder.js';

/*
 * Único punto de avance de un comprobante, como orchestration/DocumentPipeline.java: genera y firma, lo envía
 * a la recepción del SRI y consulta su autorización. Se puede llamar cuantas veces haga falta y desde varios
 * procesos a la vez.
 *
 * Cada paso es una transacción corta y las llamadas al SRI quedan fuera de toda transacción. El paso a SENDING
 * se confirma antes de transmitir: si después no hay una respuesta clara, el envío es de resultado incierto y
 * nunca se repite sin consultar antes la autorización por clave de acceso.
 *
 * Un evento puede llegar repetido. La consulta de autorización se reserva con el comprobante bloqueado
 * (`reserveQuery`): los avances que la encuentran en curso, o que llegan antes de que pase la espera desde el
 * último resultado, se descartan sin llamar al SRI ni gastar un intento. Java no lo hace (docs/route-inventory.md).
 */

export const SENDING = 'SENDING';
export const RECEIVED = 'RECEIVED';
export const RETURNED = 'RETURNED';
export const AUTHORIZED = 'AUTHORIZED';
export const NOT_AUTHORIZED = 'NOT_AUTHORIZED';

/** Evento del outbox que pone en marcha el archivo y la entrega de un comprobante autorizado. */
export const DOCUMENT_AUTHORIZED = 'DOCUMENT_AUTHORIZED';

/** Motivo del evento que deja constancia de que se agotaron los reintentos automáticos. */
export const RETRIES_EXHAUSTED = 'SRI_RETRIES_EXHAUSTED';

/** Estados de los que el comprobante no sale por sí solo. */
const NEEDS_INTERVENTION = new Set([XSD_INVALID, SIGNATURE_FAILED]);

/** Códigos con los que la recepción dice que ya tiene el comprobante (ficha técnica, sección 11). */
const ACCESS_KEY_REGISTERED = '43';
const ACCESS_KEY_IN_PROCESS = '70';

/** Lo que hace falta para llamar al SRI una vez confirmado el paso previo; attemptId nulo: no llamar. */
interface Call {
  attemptId: string | null;
  state: string;
  environment: SriEnvironment | null;
  accessKey: string | null;
  xml: Buffer | null;
  version: number;
}

const none = (state: string): Call => ({
  attemptId: null,
  state,
  environment: null,
  accessKey: null,
  xml: null,
  version: 0,
});

/** Identificadores de los mensajes del SRI, como motivo legible de un rechazo. */
function identifiers(messages: readonly SriMessage[], sriStatus: string | null): string | null {
  const joined = messages
    .map((message) => message.identifier)
    .filter((identifier): identifier is string => identifier !== null)
    .join(', ');
  return joined === '' ? sriStatus : joined;
}

const receptionIdentifiers = (result: ReceptionResult) => identifiers(result.messages, result.sriStatus);

export class DocumentPipeline {
  private readonly logger = new Logger(DocumentPipeline.name);

  constructor(
    private readonly db: Kysely<DB>,
    private readonly documents: FiscalDocumentRepository,
    private readonly processor: DocumentProcessor,
    private readonly sri: SriGateway,
    private readonly config: SriConfig,
    private readonly attempts: SriAttemptLog,
    private readonly artifacts: ArtifactStore,
    private readonly outbox: OutboxWriter,
    private readonly webhooks: WebhookRecorder,
    private readonly random: () => number = Math.random,
    /** Plazo tras el cual un comprobante autorizado que nadie archivó vuelve a anunciarse. */
    private readonly redeliveryLeaseMs: number = REDELIVERY_LEASE_MS,
  ) {}

  /** Avanza el documento todo lo que se pueda ahora y devuelve el estado en que queda. */
  async advance(tenantId: string, documentId: string): Promise<string> {
    const current = await this.documents.processingState(this.db, tenantId, documentId);
    if (current === null) throw ApiException.notFound();
    let state = current.state;
    if (state === AUTHORIZED) {
      await this.announceUntilArchived(tenantId, documentId);
      return state;
    }
    if (PENDING_STATES.includes(state)) {
      state = await this.processor.generateAndSign(tenantId, documentId);
      if (NEEDS_INTERVENTION.has(state)) await this.unschedule(tenantId, documentId);
    }
    if (state === SENDING) state = await this.resolveUncertainSend(tenantId, documentId);
    if (state === SIGNED) {
      state = await this.send(tenantId, documentId);
      // La ficha (7.4) pide esperar tras RECIBIDA: la consulta llegará con el intento programado.
      if (state === RECEIVED && this.config.authorizationDelayMs > 0) return state;
    }
    if (state === RECEIVED) state = await this.authorize(tenantId, documentId);
    return state;
  }

  private transaction<T>(work: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  private async lock(trx: Transaction<DB>, tenantId: string, documentId: string): Promise<ProcessingState> {
    const locked = await this.documents.lockForProcessing(trx, tenantId, documentId);
    if (locked === null) throw ApiException.notFound();
    return locked;
  }

  /**
   * Un comprobante sin XML válido o sin firma no se arregla reintentando: espera una corrección y un
   * reintento manual, así que no debe quedar programado (volvería a la cola una y otra vez).
   */
  private unschedule(tenantId: string, documentId: string): Promise<void> {
    return this.transaction(async (trx) => {
      // Solo si sigue en ese estado: otro proceso pudo haberlo avanzado y programado ya.
      if (NEEDS_INTERVENTION.has((await this.lock(trx, tenantId, documentId)).state)) {
        await this.documents.schedule(trx, tenantId, documentId, null, 0);
      }
    });
  }

  private async send(tenantId: string, documentId: string): Promise<string> {
    const call = await this.transaction(async (trx): Promise<Call> => {
      const locked = await this.lock(trx, tenantId, documentId);
      if (locked.state !== SIGNED) return none(locked.state);
      const environment = sriEnvironmentOf(locked.environment);
      const issuerAllowed =
        environment !== 'PRODUCTION' || (await this.documents.issuerInProduction(trx, tenantId, documentId));
      if (!isEnabled(this.config, environment) || !issuerAllowed) {
        // La transmisión en este ambiente no está habilitada, o el emisor no ha sido activado en producción:
        // el comprobante espera firmado.
        await this.documents.schedule(trx, tenantId, documentId, null, 0);
        return none(locked.state);
      }
      const xml = await this.artifacts.find(trx, tenantId, documentId, 'XML_SIGNED');
      if (xml === null) throw new Error(`Documento firmado sin su XML: ${documentId}`);
      const attemptId = await this.attempts.start(trx, tenantId, documentId, 'RECEPTION', environment);
      await this.documents.transition(trx, tenantId, documentId, SIGNED, SENDING, null);
      // Si este proceso muere antes de anotar el resultado, el documento se retoma al vencer el plazo.
      await this.documents.schedule(trx, tenantId, documentId, sendLeaseMs(this.config), locked.attemptCount);
      return { attemptId, state: SENDING, environment, accessKey: locked.accessKey, xml: xml.content, version: 0 };
    });
    if (call.attemptId === null) return call.state;
    const result = await this.sri.receive(call.environment!, call.xml!);
    return this.transaction((trx) => this.applyReception(trx, tenantId, documentId, call.attemptId!, result));
  }

  private async applyReception(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
    attemptId: string,
    result: ReceptionResult,
  ): Promise<string> {
    const locked = await this.lock(trx, tenantId, documentId);
    const alreadyThere =
      result.outcome === 'RETURNED' &&
      (hasMessage(result, ACCESS_KEY_REGISTERED) || hasMessage(result, ACCESS_KEY_IN_PROCESS));
    const outcome =
      result.outcome === 'RECEIVED'
        ? 'RECEIVED'
        : result.outcome === 'RETURNED'
          ? alreadyThere
            ? 'ALREADY_REGISTERED'
            : 'RETURNED'
          : 'UNCERTAIN';
    // Si el intento ya no está abierto, otro proceso lo dio por abandonado y se hizo cargo.
    if (!(await this.attempts.completeReception(trx, attemptId, outcome, result)) || locked.state !== SENDING) {
      return locked.state;
    }
    switch (outcome) {
      case 'RECEIVED':
      case 'ALREADY_REGISTERED':
        await this.documents.transition(
          trx,
          tenantId,
          documentId,
          SENDING,
          RECEIVED,
          alreadyThere ? `ALREADY_REGISTERED: ${receptionIdentifiers(result)}` : null,
        );
        await this.webhooks.stateReached(trx, tenantId, documentId, RECEIVED);
        // La ficha (7.4) pide esperar un tiempo antes de consultar la autorización.
        await this.documents.schedule(trx, tenantId, documentId, this.config.authorizationDelayMs, 0);
        return RECEIVED;
      case 'RETURNED':
        await this.documents.transition(trx, tenantId, documentId, SENDING, RETURNED, receptionIdentifiers(result));
        await this.webhooks.stateReached(trx, tenantId, documentId, RETURNED);
        await this.documents.schedule(trx, tenantId, documentId, null, 0);
        return RETURNED;
      default:
        await this.inconclusive(trx, tenantId, documentId, SENDING, locked.attemptCount);
        return SENDING;
    }
  }

  /**
   * Un documento en SENDING sin envío en curso es un envío de resultado incierto. Se pregunta al SRI por la
   * clave de acceso: si la conoce, se da por recibido; solo si no la conoce se reenvía.
   */
  private async resolveUncertainSend(tenantId: string, documentId: string): Promise<string> {
    const call = await this.transaction(async (trx): Promise<Call> => {
      const locked = await this.lock(trx, tenantId, documentId);
      if (locked.state !== SENDING || (await this.attempts.sendInFlight(trx, documentId, sendLeaseMs(this.config)))) {
        return none(locked.state);
      }
      const environment = sriEnvironmentOf(locked.environment);
      const attemptId = await this.reserveQuery(trx, tenantId, documentId, locked, environment);
      if (attemptId === null) return none(locked.state);
      await this.attempts.abandonSends(trx, documentId);
      return { attemptId, state: SENDING, environment, accessKey: locked.accessKey, xml: null, version: locked.version };
    });
    if (call.attemptId === null) return call.state;
    const result = await this.sri.authorize(call.environment!, call.accessKey!);
    return this.transaction(async (trx) => {
      const locked = await this.lock(trx, tenantId, documentId);
      // Solo cuenta una respuesta sobre esta clave de acceso. Sobre todo el "no encontrado": es lo único que
      // permite reenviar.
      const outcome =
        result.outcome === 'FAILED'
          ? 'UNCERTAIN'
          : call.accessKey === result.consultedAccessKey
            ? result.outcome
            : 'MISMATCH';
      const open = await this.attempts.completeAuthorization(trx, call.attemptId!, outcome, result, true);
      // Otro proceso dio la consulta por abandonada, o movió el documento mientras se consultaba: su decisión manda.
      if (!open || locked.state !== SENDING || locked.version !== call.version) return locked.state;
      switch (outcome) {
        case 'AUTHORIZED':
        case 'NOT_AUTHORIZED':
        case 'PROCESSING':
          await this.documents.transition(trx, tenantId, documentId, SENDING, RECEIVED, 'FOUND_AFTER_UNCERTAIN_SEND');
          await this.webhooks.stateReached(trx, tenantId, documentId, RECEIVED);
          await this.documents.schedule(trx, tenantId, documentId, 0, 0);
          return RECEIVED;
        case 'NOT_FOUND':
          await this.documents.transition(trx, tenantId, documentId, SENDING, SIGNED, 'RESEND_AFTER_NOT_FOUND');
          return SIGNED;
        default:
          await this.inconclusive(trx, tenantId, documentId, SENDING, locked.attemptCount);
          return SENDING;
      }
    });
  }

  /**
   * Anuncia que el comprobante está autorizado, para que se archive y se entregue. Queda programado como red
   * de seguridad: si el anuncio se pierde, se repite al vencer el plazo.
   */
  private async announceAuthorized(trx: Transaction<DB>, tenantId: string, documentId: string): Promise<void> {
    await this.outbox.write(trx, tenantId, documentId, DOCUMENT_AUTHORIZED, { documentId });
    await this.documents.schedule(trx, tenantId, documentId, this.redeliveryLeaseMs, 0);
  }

  /** Un comprobante autorizado solo necesita atención mientras no esté archivado. */
  private announceUntilArchived(tenantId: string, documentId: string): Promise<void> {
    return this.transaction(async (trx) => {
      if ((await this.lock(trx, tenantId, documentId)).state !== AUTHORIZED) return;
      if (await this.artifacts.exists(trx, tenantId, documentId, 'RIDE_PDF')) {
        await this.documents.schedule(trx, tenantId, documentId, null, 0);
      } else {
        await this.announceAuthorized(trx, tenantId, documentId);
      }
    });
  }

  /**
   * Abre la consulta de autorización de un comprobante bloqueado y lo programa para el plazo de la llamada, por
   * si este proceso muere antes de anotar el resultado. Nulo si el avance es un duplicado: hay una consulta en
   * curso, o no ha pasado la espera desde el último resultado no concluyente.
   *
   * La espera se mide desde el último intento y no con `next_attempt_at`, porque el planificador lo mueve a su
   * plazo de reentrega al encolar el evento legítimo. Cuenta la espera más corta posible (sin la variación al
   * alza). Con la cuenta a cero (recién recibido, o un reintento manual) no hay nada que esperar.
   */
  private async reserveQuery(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
    locked: ProcessingState,
    environment: SriEnvironment,
  ): Promise<string | null> {
    const lease = sendLeaseMs(this.config);
    if (await this.attempts.queryInFlight(trx, documentId, lease)) return null;
    if (locked.attemptCount > 0) {
      const { retryBackoffMs, retryMaxBackoffMs } = this.config;
      const since = await this.attempts.sinceLastResultMs(trx, documentId);
      const remaining = since === null ? 0 : retryDelayMs(locked.attemptCount, retryBackoffMs, retryMaxBackoffMs, 0) - since;
      if (remaining > 0) {
        await this.documents.bringForward(trx, tenantId, documentId, remaining);
        return null;
      }
    }
    await this.attempts.abandonQueries(trx, documentId);
    const attemptId = await this.attempts.start(trx, tenantId, documentId, 'AUTHORIZATION', environment);
    await this.documents.schedule(trx, tenantId, documentId, lease, locked.attemptCount);
    return attemptId;
  }

  /** Consulta la autorización de un comprobante recibido y, si hay resultado definitivo, lo cierra. */
  private async authorize(tenantId: string, documentId: string): Promise<string> {
    const call = await this.transaction(async (trx): Promise<Call> => {
      const locked = await this.lock(trx, tenantId, documentId);
      if (locked.state !== RECEIVED) return none(locked.state);
      const environment = sriEnvironmentOf(locked.environment);
      const attemptId = await this.reserveQuery(trx, tenantId, documentId, locked, environment);
      if (attemptId === null) return none(locked.state);
      return { attemptId, state: RECEIVED, environment, accessKey: locked.accessKey, xml: null, version: locked.version };
    });
    if (call.attemptId === null) return call.state;
    const environment = call.environment!;
    const result = await this.sri.authorize(environment, call.accessKey!);
    return this.transaction(async (trx) => {
      const locked = await this.lock(trx, tenantId, documentId);
      const sameKey = locked.accessKey === result.consultedAccessKey;
      let outcome: string;
      switch (result.outcome) {
        // Solo vale una autorización de esta clave de acceso y de este ambiente.
        case 'AUTHORIZED':
          outcome = sameKey && matchesLabel(environment, result.environmentLabel) ? 'AUTHORIZED' : 'MISMATCH';
          break;
        case 'NOT_AUTHORIZED':
          outcome = sameKey ? 'NOT_AUTHORIZED' : 'MISMATCH';
          break;
        case 'FAILED':
          outcome = 'UNCERTAIN';
          break;
        default:
          outcome = result.outcome;
      }
      const applies = locked.state === RECEIVED;
      // La respuesta que autoriza se conserva como artefacto; guardarla también aquí la duplicaría.
      const open = await this.attempts.completeAuthorization(
        trx,
        call.attemptId!,
        outcome,
        result,
        !(applies && outcome === 'AUTHORIZED'),
      );
      // Si el intento ya no está abierto, otro proceso lo dio por abandonado y se hizo cargo.
      if (!applies || !open) return locked.state;
      switch (outcome) {
        case 'AUTHORIZED':
          await this.artifacts.save(trx, tenantId, documentId, 'SRI_AUTHORIZATION', result.rawResponse!);
          await this.documents.markAuthorized(trx, tenantId, documentId, result.authorizationNumber!, result.authorizedAt!);
          await this.documents.transition(trx, tenantId, documentId, RECEIVED, AUTHORIZED, null);
          await this.webhooks.stateReached(trx, tenantId, documentId, AUTHORIZED);
          await this.announceAuthorized(trx, tenantId, documentId);
          return AUTHORIZED;
        case 'NOT_AUTHORIZED':
          await this.documents.transition(
            trx,
            tenantId,
            documentId,
            RECEIVED,
            NOT_AUTHORIZED,
            identifiers(result.messages, result.sriStatus),
          );
          await this.webhooks.stateReached(trx, tenantId, documentId, NOT_AUTHORIZED);
          await this.documents.schedule(trx, tenantId, documentId, null, 0);
          return NOT_AUTHORIZED;
        default:
          await this.inconclusive(trx, tenantId, documentId, RECEIVED, locked.attemptCount);
          return RECEIVED;
      }
    });
  }

  /**
   * Anota un intento sin resultado definitivo y programa el siguiente con una espera creciente. Agotados los
   * intentos, el documento deja de reintentarse solo y queda constancia en su historial.
   */
  private async inconclusive(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
    state: string,
    previousAttempts: number,
  ): Promise<void> {
    const count = previousAttempts + 1;
    if (count >= this.config.retryMaxAttempts) {
      await this.documents.schedule(trx, tenantId, documentId, null, count);
      await this.documents.recordStateChange(trx, tenantId, documentId, state, state, RETRIES_EXHAUSTED);
      this.logger.warn(`El documento ${documentId} agotó sus ${count} intentos ante el SRI en estado ${state}`);
      return;
    }
    const delay = retryDelayMs(count, this.config.retryBackoffMs, this.config.retryMaxBackoffMs, this.random());
    await this.documents.schedule(trx, tenantId, documentId, delay, count);
  }
}
