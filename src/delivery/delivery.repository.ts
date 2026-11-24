import { type Kysely, sql, type Transaction } from 'kysely';
import { isoInstant } from '../common/java-time.js';
import type { DB } from '../database/schema.js';

/*
 * Entregas de los comprobantes, como delivery/DeliveryRepository.java. Cada cambio de estado es una sola sentencia:
 * reservar una entrega para enviarla es atómico, así que dos procesos nunca envían la misma a la vez.
 */

type Db = Kysely<DB> | Transaction<DB>;

/** Las fechas van como el ISO_INSTANT de Jackson. */
export interface DeliveryRow {
  id: string;
  channel: string;
  recipient: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  requestedBy: string | null;
}

/** Entrega reservada para enviar ahora; el número de intento identifica la reserva al anotar un fallo. */
export interface DeliveryClaim {
  recipient: string;
  attemptCount: number;
}

interface DeliverySqlRow {
  id: string;
  channel: string;
  recipient: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
  created: string;
  sent: string | null;
  requested_by: string | null;
}

const utc = (column: string) => sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`);

const COLUMNS = sql`id, channel, recipient, status, attempt_count, last_error, ${utc('created_at')} AS created,
  ${utc('sent_at')} AS sent, requested_by`;

function rowOf(row: DeliverySqlRow): DeliveryRow {
  return {
    id: row.id,
    channel: row.channel,
    recipient: row.recipient,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    createdAt: isoInstant(row.created),
    sentAt: row.sent === null ? null : isoInstant(row.sent),
    requestedBy: row.requested_by,
  };
}

const interval = (ms: number) => sql`make_interval(secs => CAST(${ms / 1000} AS double precision))`;

/** Pendiente cuya espera ya pasó, o con un envío que se quedó a medias. */
const ready = (leaseMs: number) => sql`((status = 'PENDING' AND (retry_after IS NULL OR retry_after <= now()))
  OR (status = 'SENDING' AND sending_since < now() - ${interval(leaseMs)}))`;

export class DeliveryRepository {
  /** Crea la entrega automática del comprobante si aún no existe. Devuelve si la creó. */
  async ensureAutomatic(db: Db, tenantId: string, documentId: string, recipient: string): Promise<boolean> {
    const result = await sql`
      INSERT INTO deliveries (tenant_id, document_id, channel, recipient, status, next_attempt_at)
      VALUES (${tenantId}, ${documentId}, 'EMAIL', ${recipient}, 'PENDING', now())
      ON CONFLICT (document_id, channel) WHERE requested_by IS NULL DO NOTHING`.execute(db);
    return Number(result.numAffectedRows ?? 0) === 1;
  }

  /** Si el comprobante ya tiene su entrega automática. */
  async hasAutomatic(db: Db, documentId: string): Promise<boolean> {
    const result = await sql<{ found: boolean }>`
      SELECT EXISTS (SELECT 1 FROM deliveries WHERE document_id = ${documentId} AND channel = 'EMAIL'
       AND requested_by IS NULL) AS found`.execute(db);
    return result.rows[0]!.found;
  }

  /** Crea una entrega pedida por un usuario. */
  async create(db: Db, tenantId: string, documentId: string, recipient: string, requestedBy: string): Promise<string> {
    const result = await sql<{ id: string }>`
      INSERT INTO deliveries (tenant_id, document_id, channel, recipient, status, next_attempt_at, requested_by)
      VALUES (${tenantId}, ${documentId}, 'EMAIL', ${recipient}, 'PENDING', now(), ${requestedBy})
      RETURNING id`.execute(db);
    return result.rows[0]!.id;
  }

  /** Entregas del comprobante que se pueden intentar ahora. */
  async pending(db: Db, tenantId: string, documentId: string, leaseMs: number): Promise<string[]> {
    const result = await sql<{ id: string }>`
      SELECT id FROM deliveries
      WHERE tenant_id = ${tenantId} AND document_id = ${documentId} AND ${ready(leaseMs)}
      ORDER BY created_at, id`.execute(db);
    return result.rows.map((row) => row.id);
  }

  /**
   * Reserva la entrega para enviarla. Nulo si otro proceso se adelantó o si aún no ha pasado la espera de su
   * reintento. Queda programada al vencer el plazo de envío: si este proceso muere antes de anotar el resultado, se
   * retoma entonces.
   */
  async claim(db: Db, deliveryId: string, leaseMs: number): Promise<DeliveryClaim | null> {
    const result = await sql<{ recipient: string; attempt_count: number }>`
      UPDATE deliveries
      SET status = 'SENDING', sending_since = now(), attempt_count = attempt_count + 1,
       next_attempt_at = now() + ${interval(leaseMs)}
      WHERE id = ${deliveryId} AND ${ready(leaseMs)}
      RETURNING recipient, attempt_count`.execute(db);
    const row = result.rows[0];
    return row === undefined ? null : { recipient: row.recipient, attemptCount: row.attempt_count };
  }

  /**
   * Anota que el servidor aceptó el mensaje. Vale aunque otro intento haya tomado después la entrega: el correo ya
   * salió, y anotarlo evita que se repita. Devuelve si es la primera vez que se anota.
   */
  async markSent(db: Db, deliveryId: string, providerMessageId: string): Promise<boolean> {
    const result = await sql`
      UPDATE deliveries
      SET status = 'SENT', sent_at = now(), provider_message_id = ${providerMessageId}, next_attempt_at = NULL,
       retry_after = NULL, sending_since = NULL, last_error = NULL
      WHERE id = ${deliveryId} AND status <> 'SENT'`.execute(db);
    return Number(result.numAffectedRows ?? 0) === 1;
  }

  /**
   * Anota un fallo temporal del intento indicado y la espera antes del siguiente. No hace nada si ese intento ya no
   * es el vigente: otro proceso tomó la entrega y su resultado manda.
   */
  async markRetry(db: Db, deliveryId: string, attempt: number, delayMs: number, error: string): Promise<void> {
    await sql`
      UPDATE deliveries
      SET status = 'PENDING', sending_since = NULL, last_error = ${error},
       retry_after = now() + ${interval(delayMs)}, next_attempt_at = now() + ${interval(delayMs)}
      WHERE id = ${deliveryId} AND status = 'SENDING' AND attempt_count = ${attempt}`.execute(db);
  }

  /** Anota un fallo definitivo del intento indicado, con la misma salvedad que `markRetry`. */
  async markFailed(db: Db, deliveryId: string, attempt: number, error: string): Promise<void> {
    await sql`
      UPDATE deliveries
      SET status = 'FAILED', sending_since = NULL, next_attempt_at = NULL, retry_after = NULL, last_error = ${error}
      WHERE id = ${deliveryId} AND status = 'SENDING' AND attempt_count = ${attempt}`.execute(db);
  }

  /** Entregas del comprobante, la más reciente primero. */
  async list(db: Db, tenantId: string, documentId: string): Promise<DeliveryRow[]> {
    const result = await sql<DeliverySqlRow>`
      SELECT ${COLUMNS} FROM deliveries WHERE tenant_id = ${tenantId} AND document_id = ${documentId}
      ORDER BY created_at DESC, id`.execute(db);
    return result.rows.map(rowOf);
  }

  async find(db: Db, tenantId: string, deliveryId: string): Promise<DeliveryRow | null> {
    const result = await sql<DeliverySqlRow>`
      SELECT ${COLUMNS} FROM deliveries WHERE tenant_id = ${tenantId} AND id = ${deliveryId}`.execute(db);
    const row = result.rows[0];
    return row === undefined ? null : rowOf(row);
  }

  async count(db: Db, documentId: string): Promise<number> {
    const result = await sql<{ count: string }>`
      SELECT count(*) AS count FROM deliveries WHERE document_id = ${documentId}`.execute(db);
    return Number(result.rows[0]!.count);
  }
}
