import { type Kysely, sql } from 'kysely';
import type { OutboxWriter } from '../billing/outbox-writer.js';
import { REDELIVERY_LEASE_MS } from '../config/app-config.js';
import type { DB } from '../database/schema.js';

/*
 * Devuelve a la cola de entrega los comprobantes con una entrega cuyo siguiente intento ya venció, como
 * delivery/DueDeliveryScheduler.java: reintentos de correo y envíos que se quedaron sin resultado.
 */

export const DELIVERY_DUE = 'DELIVERY_DUE';

const BATCH = 100;

export class DueDeliveryScheduler {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly outbox: OutboxWriter,
    private readonly redeliveryLeaseMs: number = REDELIVERY_LEASE_MS,
  ) {}

  /** Deja un evento por cada comprobante con entregas vencidas y devuelve cuántos fueron. */
  enqueueDue(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      // El plazo nuevo es una red de seguridad: si el mensaje se pierde, la entrega vuelve a salir.
      const due = (
        await sql<{ tenant_id: string; document_id: string }>`
          UPDATE deliveries
          SET next_attempt_at = now() + make_interval(secs => CAST(${this.redeliveryLeaseMs / 1000} AS double precision))
          WHERE id IN (SELECT id FROM deliveries WHERE next_attempt_at <= now()
           ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
          RETURNING tenant_id, document_id`.execute(trx)
      ).rows;
      const documents = new Map(due.map((row) => [row.document_id, row.tenant_id]));
      for (const [documentId, tenantId] of documents) {
        await this.outbox.write(trx, tenantId, documentId, DELIVERY_DUE, { documentId });
      }
      return documents.size;
    });
  }
}
