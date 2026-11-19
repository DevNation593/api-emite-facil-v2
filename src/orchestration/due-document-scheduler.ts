import { type Kysely, sql } from 'kysely';
import type { OutboxWriter } from '../billing/outbox-writer.js';
import { REDELIVERY_LEASE_MS } from '../config/app-config.js';
import type { DB } from '../database/schema.js';

/*
 * Devuelve a la cola los comprobantes cuyo siguiente intento ya venció, como
 * orchestration/DueDocumentScheduler.java: reintentos ante el SRI, consultas de autorización pendientes y envíos
 * que se quedaron sin resultado.
 */

export const DOCUMENT_DUE = 'DOCUMENT_DUE';

const BATCH = 100;

export class DueDocumentScheduler {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly outbox: OutboxWriter,
    private readonly redeliveryLeaseMs: number = REDELIVERY_LEASE_MS,
  ) {}

  /** Deja un evento por cada documento vencido y devuelve cuántos fueron. */
  enqueueDue(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      // El plazo nuevo es una red de seguridad: si el mensaje se pierde o el worker muere, el documento vuelve
      // a salir. Quien lo procese fijará el siguiente intento real.
      const due = (
        await sql<{ tenant_id: string; id: string }>`
          UPDATE fiscal_documents
          SET next_attempt_at = now() + make_interval(secs => CAST(${this.redeliveryLeaseMs / 1000} AS double precision))
          WHERE id IN (SELECT id FROM fiscal_documents WHERE next_attempt_at <= now()
           ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
          RETURNING tenant_id, id`.execute(trx)
      ).rows;
      for (const document of due) {
        await this.outbox.write(trx, document.tenant_id, document.id, DOCUMENT_DUE, { documentId: document.id });
      }
      return due.length;
    });
  }
}
