import { type Kysely, sql } from 'kysely';
import type { ConfirmChannel } from 'amqplib';
import type { DB } from '../database/schema.js';
import type { RabbitConnection } from '../infrastructure/rabbit.module.js';
import { declareTopology, EVENTS_EXCHANGE, routingKey } from './messaging.js';

/*
 * Publica en RabbitMQ los eventos pendientes del outbox, como orchestration/OutboxRelay.java. Un evento se marca
 * como despachado solo después de que el broker confirma haberlo recibido; si algo falla se publica otra vez más
 * tarde, así que un mismo evento puede llegar repetido y quien lo consume debe tolerarlo.
 */

const BATCH = 50;
const CONFIRM_TIMEOUT_MS = 10_000;

interface PendingEvent {
  id: string;
  tenant_id: string;
  aggregate_id: string;
  event_type: string;
}

/** El mensaje lleva solo identificadores: nunca XML, datos del cliente ni certificados. */
function body(event: PendingEvent): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId: event.id,
      tenantId: event.tenant_id,
      documentId: event.aggregate_id,
      eventType: event.event_type,
    }),
    'utf8',
  );
}

export class OutboxRelay {
  /** La topología se declara una vez por proceso y otra vez tras cualquier fallo (el broker pudo cambiar). */
  private declared = false;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly rabbit: RabbitConnection,
    /** Plazo para abrir el canal, publicar el lote y recibir las confirmaciones. */
    private readonly timeoutMs: number = CONFIRM_TIMEOUT_MS,
  ) {}

  /** Publica un lote de eventos pendientes y devuelve cuántos fueron. Si algo falla, lanza y no marca nada. */
  publishPending(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      // SKIP LOCKED: varias instancias pueden publicar a la vez sin estorbarse ni repetir el lote.
      const events = (
        await sql<PendingEvent>`
          SELECT id, tenant_id, aggregate_id, event_type FROM outbox_events
          WHERE dispatched_at IS NULL ORDER BY created_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`.execute(trx)
      ).rows;
      if (events.length === 0) return 0;
      try {
        await this.publish(events);
      } catch (error) {
        this.declared = false;
        throw error;
      }
      await sql`UPDATE outbox_events SET dispatched_at = now() WHERE id = ANY(${events.map((e) => e.id)}::uuid[])`.execute(
        trx,
      );
      return events.length;
    });
  }

  /** Publica el lote en un canal propio y espera las confirmaciones del broker, todo dentro del plazo. */
  private async publish(events: PendingEvent[]): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let expired = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error(`RabbitMQ no confirmó la publicación en ${this.timeoutMs / 1000} s`));
      }, this.timeoutMs);
    });
    const opening = this.rabbit.channel();
    // Si el plazo vence antes de abrir el canal, el canal que llegue tarde se cierra sin usarse.
    opening.then(
      (late) => {
        if (expired) void late.close().catch(() => undefined);
      },
      () => undefined,
    );
    let channel: ConfirmChannel | undefined;
    try {
      channel = await Promise.race([opening, deadline]);
      const open = channel;
      const work = (async () => {
        if (!this.declared) {
          await declareTopology(open);
          this.declared = true;
        }
        for (const event of events) {
          open.publish(EVENTS_EXCHANGE, routingKey(event.event_type), body(event), {
            contentType: 'application/json',
            messageId: event.id,
            persistent: true,
          });
        }
        await open.waitForConfirms();
      })();
      // Si vence el plazo, lo que quede de la publicación puede fallar después: no debe quedar sin atender.
      work.catch(() => undefined);
      await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
      if (channel !== undefined) void channel.close().catch(() => undefined);
    }
  }
}
