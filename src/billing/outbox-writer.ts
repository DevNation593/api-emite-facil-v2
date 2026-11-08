import { type Transaction, sql } from 'kysely';
import type { DB } from '../database/schema.js';

/**
 * Deja un evento por publicar en la misma transacción que el cambio de negocio
 * (billing/OutboxWriter.java). El payload lleva solo identificadores: nunca XML, certificados ni
 * datos del cliente.
 */
export class OutboxWriter {
  async write(
    trx: Transaction<DB>,
    tenantId: string,
    aggregateId: string,
    eventType: string,
    identifiers: Record<string, string>,
  ): Promise<void> {
    // Una Kysely suelta no es una transacción: el evento podría confirmarse sin su cambio.
    if (!trx.isTransaction) {
      throw new Error(
        'El outbox se escribe dentro de la transacción del cambio que publica',
      );
    }
    await sql`
      INSERT INTO outbox_events (tenant_id, aggregate_id, event_type, payload)
      VALUES (${tenantId}, ${aggregateId}, ${eventType}, CAST(${JSON.stringify(identifiers)} AS jsonb))`.execute(
      trx,
    );
  }
}
