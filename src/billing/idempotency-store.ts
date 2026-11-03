import { type Transaction, sql } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import type { DB } from '../database/schema.js';

/**
 * Registro de claves de idempotencia por tenant (billing/IdempotencyStore.java). La unicidad la
 * garantiza la clave primaria: un segundo intento simultáneo espera a que el primero confirme o
 * revierta, y entonces o encuentra el documento ya creado o toma él la clave.
 */
export class IdempotencyStore {
  /**
   * Toma la clave para la transacción en curso, que es obligatoria. Devuelve nulo si es un intento
   * nuevo, o el documento del intento anterior si la clave ya se usó con la misma petición.
   */
  async begin(
    trx: Transaction<DB>,
    tenantId: string,
    key: string,
    requestHash: string,
  ): Promise<string | null> {
    requireTransaction(trx);
    const inserted = await sql`
      INSERT INTO idempotency_records (tenant_id, idempotency_key, request_hash)
      VALUES (${tenantId}, ${key}, ${requestHash})
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`.execute(trx);
    if (inserted.numAffectedRows === 1n) return null;
    const result = await sql<{
      request_hash: string;
      document_id: string | null;
    }>`
      SELECT request_hash, document_id FROM idempotency_records
      WHERE tenant_id = ${tenantId} AND idempotency_key = ${key}`.execute(trx);
    const existing = result.rows[0];
    if (existing === undefined) {
      throw new Error(
        'El registro de idempotencia desapareció dentro de la transacción',
      );
    }
    if (
      existing.request_hash !== requestHash ||
      existing.document_id === null
    ) {
      throw new ApiException(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'La clave de idempotencia ya se usó con una petición distinta',
      );
    }
    return existing.document_id;
  }

  async complete(
    trx: Transaction<DB>,
    tenantId: string,
    key: string,
    documentId: string,
  ): Promise<void> {
    requireTransaction(trx);
    await sql`
      UPDATE idempotency_records SET document_id = ${documentId}
      WHERE tenant_id = ${tenantId} AND idempotency_key = ${key}`.execute(trx);
  }
}

function requireTransaction(trx: Transaction<DB>): void {
  if (!trx.isTransaction) {
    throw new Error(
      'La idempotencia se registra dentro de la transacción de la emisión',
    );
  }
}
