import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '../database/schema.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';

/**
 * Bitácora de auditoría. Se escribe dentro de la transacción del cambio que registra: si el cambio
 * no se confirma, el evento tampoco. Por eso recibe siempre la transacción (equivale a
 * Propagation.MANDATORY de Java) y nunca abre una propia.
 */
export class AuditLog {
  /** Registra el evento de quien llama; si entró con una key, queda dicha key junto a quien la creó. */
  async recordFor(
    trx: Transaction<DB>,
    access: TenantAccess,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.insert(
      trx,
      access.tenantId,
      access.userId,
      access.apiKeyId,
      action,
      entityType,
      entityId,
      metadata,
    );
  }

  /** Registra el evento de una persona con su sesión: no lleva key. */
  async record(
    trx: Transaction<DB>,
    tenantId: string,
    actorId: string,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.insert(trx, tenantId, actorId, null, action, entityType, entityId, metadata);
  }

  private async insert(
    trx: Transaction<DB>,
    tenantId: string,
    actorId: string,
    apiKeyId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // Una Kysely suelta no es una transacción: el evento podría confirmarse sin su cambio.
    if (!trx.isTransaction) {
      throw new Error('La auditoría se escribe dentro de la transacción del cambio que registra');
    }
    await trx
      .insertInto('audit_events')
      .values({
        tenant_id: tenantId,
        actor_id: actorId,
        api_key_id: apiKeyId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        // jsonb: se pasa el texto JSON y se convierte en la base, como hace Java.
        metadata: sql`CAST(${JSON.stringify(metadata)} AS jsonb)`,
      })
      .execute();
  }
}
