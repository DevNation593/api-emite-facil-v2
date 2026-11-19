import { type Kysely, sql, type Transaction } from 'kysely';
import { Histogram, type Registry } from 'prom-client';
import { isoInstant } from '../common/java-time.js';
import type { DB } from '../database/schema.js';
import { codeOf, type SriEnvironment } from './sri-environment.js';
import type { AuthorizationResult, ReceptionResult, SriMessage } from './sri-results.js';

/*
 * Bitácora de las llamadas al SRI, como sri/SriAttemptLog.java. Un intento se abre antes de llamar y se
 * cierra con su resultado; mientras está abierto (outcome nulo) la llamada se considera en curso.
 */

type Db = Kysely<DB> | Transaction<DB>;

export type SriOperation = 'RECEPTION' | 'AUTHORIZATION';

export interface MessageView {
  identifier: string | null;
  message: string | null;
  additionalInfo: string | null;
  type: string | null;
}

export interface AttemptView {
  id: string;
  operation: string;
  outcome: string | null;
  sriStatus: string | null;
  httpStatus: number | null;
  /** ISO_INSTANT, como lo escribe Jackson. */
  startedAt: string;
  completedAt: string | null;
  messages: MessageView[];
}

/** Instante en UTC con microsegundos, el texto que espera `isoInstant`. */
const utc = (column: string) => sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`);

export class SriAttemptLog {
  private readonly calls: Histogram<'operation' | 'environment' | 'outcome'>;

  constructor(registry: Registry) {
    // Cuánto tardó el SRI y qué respondió, por operación y ambiente: sin datos del comprobante.
    this.calls = new Histogram({
      name: 'einvoice_sri_calls_seconds',
      help: 'Llamadas al SRI',
      labelNames: ['operation', 'environment', 'outcome'],
      registers: [registry],
    });
  }

  /** Abre un intento y devuelve su id. */
  async start(
    db: Db,
    tenantId: string,
    documentId: string,
    operation: SriOperation,
    environment: SriEnvironment,
  ): Promise<string> {
    const result = await sql<{ id: string }>`
      INSERT INTO sri_attempts (tenant_id, document_id, operation, environment)
      VALUES (${tenantId}, ${documentId}, ${operation}, ${codeOf(environment)}) RETURNING id`.execute(db);
    return result.rows[0]!.id;
  }

  /**
   * Cierra el intento con el resultado de la recepción. Devuelve false si ya estaba cerrado (otro proceso lo
   * dio por abandonado): en ese caso el resultado no debe aplicarse al documento.
   */
  completeReception(db: Db, attemptId: string, outcome: string, result: ReceptionResult): Promise<boolean> {
    return this.complete(db, attemptId, outcome, result, result.rawResponse);
  }

  /** Cierra el intento con el resultado de la autorización; la respuesta se guarda solo si se pide. */
  completeAuthorization(
    db: Db,
    attemptId: string,
    outcome: string,
    result: AuthorizationResult,
    keepResponse: boolean,
  ): Promise<boolean> {
    return this.complete(db, attemptId, outcome, result, keepResponse ? result.rawResponse : null);
  }

  private async complete(
    db: Db,
    attemptId: string,
    outcome: string,
    result: { sriStatus: string | null; httpStatus: number | null; errorDetail: string | null; messages: SriMessage[] },
    response: Buffer | null,
  ): Promise<boolean> {
    const closed = await sql<{ operation: string; environment: string; seconds: string }>`
      UPDATE sri_attempts
      SET outcome = ${outcome}, sri_status = ${result.sriStatus}, http_status = ${result.httpStatus},
       error_detail = ${result.errorDetail}, response = ${response}, completed_at = clock_timestamp()
      WHERE id = ${attemptId} AND outcome IS NULL
      RETURNING operation, environment, extract(epoch FROM (completed_at - started_at)) AS seconds`.execute(db);
    const row = closed.rows[0];
    if (row === undefined) return false;
    this.calls
      .labels({ operation: row.operation, environment: row.environment, outcome })
      .observe(Math.max(0, Number(row.seconds)));
    for (const [index, message] of result.messages.entries()) {
      await sql`
        INSERT INTO sri_messages (attempt_id, position, identifier, message, additional_info, type)
        VALUES (${attemptId}, ${index + 1}, ${message.identifier}, ${message.message}, ${message.additionalInfo},
         ${message.type})`.execute(db);
    }
    return true;
  }

  /** Si hay un envío a la recepción abierto hace menos del plazo dado: sigue en curso. */
  async sendInFlight(db: Db, documentId: string, leaseMs: number): Promise<boolean> {
    const result = await sql<{ count: string }>`
      SELECT count(*) AS count FROM sri_attempts
      WHERE document_id = ${documentId} AND operation = 'RECEPTION' AND outcome IS NULL
       AND started_at > now() - make_interval(secs => CAST(${leaseMs / 1000} AS double precision))`.execute(db);
    return Number(result.rows[0]!.count) > 0;
  }

  /** Da por abandonados los envíos a la recepción que quedaron abiertos. */
  async abandonSends(db: Db, documentId: string): Promise<number> {
    const result = await sql`
      UPDATE sri_attempts SET outcome = 'ABANDONED', completed_at = clock_timestamp()
      WHERE document_id = ${documentId} AND operation = 'RECEPTION' AND outcome IS NULL`.execute(db);
    return Number(result.numAffectedRows ?? 0);
  }

  /** Intentos del documento con sus mensajes, el más reciente primero. Nunca la respuesta cruda. */
  async list(db: Db, tenantId: string, documentId: string): Promise<AttemptView[]> {
    const attempts = await sql<{
      id: string;
      operation: string;
      outcome: string | null;
      sri_status: string | null;
      http_status: number | null;
      started_at: string;
      completed_at: string | null;
    }>`
      SELECT id, operation, outcome, sri_status, http_status, ${utc('started_at')} AS started_at,
       ${utc('completed_at')} AS completed_at
      FROM sri_attempts
      WHERE tenant_id = ${tenantId} AND document_id = ${documentId} ORDER BY started_at DESC, id`.execute(db);
    const messages = await sql<{
      attempt_id: string;
      identifier: string | null;
      message: string | null;
      additional_info: string | null;
      type: string | null;
    }>`
      SELECT m.attempt_id, m.identifier, m.message, m.additional_info, m.type
      FROM sri_messages m JOIN sri_attempts a ON a.id = m.attempt_id
      WHERE a.tenant_id = ${tenantId} AND a.document_id = ${documentId} ORDER BY m.attempt_id, m.position`.execute(db);
    return attempts.rows.map((attempt) => ({
      id: attempt.id,
      operation: attempt.operation,
      outcome: attempt.outcome,
      sriStatus: attempt.sri_status,
      httpStatus: attempt.http_status,
      startedAt: isoInstant(attempt.started_at),
      completedAt: attempt.completed_at === null ? null : isoInstant(attempt.completed_at),
      messages: messages.rows
        .filter((message) => message.attempt_id === attempt.id)
        .map((message) => ({
          identifier: message.identifier,
          message: message.message,
          additionalInfo: message.additional_info,
          type: message.type,
        })),
    }));
  }
}
