import type { Transaction } from 'kysely';
import type { DB } from '../database/schema.js';

/**
 * Aviso de que un comprobante llegó a un estado que los webhooks anuncian (RECEIVED, RETURNED, AUTHORIZED y
 * NOT_AUTHORIZED). Se llama dentro de la transacción del cambio, como en Java. E6 pone la implementación real
 * (las entregas de webhooks); hasta entonces no se hace nada.
 */
export interface WebhookRecorder {
  stateReached(trx: Transaction<DB>, tenantId: string, documentId: string, state: string): Promise<void>;
}

export const WEBHOOK_RECORDER = Symbol('WEBHOOK_RECORDER');

export class NoWebhooks implements WebhookRecorder {
  async stateReached(): Promise<void> {
    // Sin webhooks hasta E6.
  }
}
