import { type Kysely, sql, type Transaction } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import type { AuditLog } from '../compliance/audit-log.js';
import type { DB } from '../database/schema.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';

/** Valor de next_value cuando ya se entregó el 999999999. */
const EXHAUSTED = 1_000_000_000;

export interface SequenceView {
  emissionPointId: string;
  environment: string;
  documentType: string;
  nextValue: number;
}

/**
 * Secuenciales de comprobantes: un contador por punto de emisión, ambiente y tipo de documento. La
 * reserva bloquea la fila del contador hasta que termina la transacción que emite el comprobante,
 * así que dos emisiones simultáneas nunca reciben el mismo número y una emisión que falla lo devuelve.
 */
export class SequenceService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly audit: AuditLog,
  ) {}

  /**
   * Entrega el siguiente secuencial dentro de la transacción en curso, que es obligatoria
   * (Propagation.MANDATORY). La fecha de emisión (YYYY-MM-DD) no puede ser anterior a la del último
   * comprobante del contador (orden cronológico, ficha 9.18).
   */
  async reserve(
    trx: Transaction<DB>,
    tenantId: string,
    emissionPointId: string,
    environment: string,
    documentType: string,
    issueDate: string,
  ): Promise<number> {
    if (!trx.isTransaction) {
      throw new Error('La reserva del secuencial exige una transacción abierta');
    }
    await trx
      .insertInto('document_sequences')
      .values({
        tenant_id: tenantId,
        emission_point_id: emissionPointId,
        environment,
        document_type: documentType,
      })
      .onConflict((oc) => oc.columns(['emission_point_id', 'environment', 'document_type']).doNothing())
      .execute();
    const counter = await trx
      .selectFrom('document_sequences')
      .select(['next_value', 'last_issue_date'])
      .where('emission_point_id', '=', emissionPointId)
      .where('environment', '=', environment)
      .where('document_type', '=', documentType)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const nextValue = Number(counter.next_value);
    if (nextValue >= EXHAUSTED) {
      throw new ApiException(
        422,
        'SEQUENCE_EXHAUSTED',
        'El punto de emisión agotó sus secuenciales para este tipo de comprobante',
      );
    }
    if (counter.last_issue_date !== null && issueDate < counter.last_issue_date) {
      throw new ApiException(
        422,
        'INVALID_ISSUE_DATE',
        'La fecha de emisión no puede ser anterior a la del último comprobante del punto de emisión',
      );
    }
    await trx
      .updateTable('document_sequences')
      .set({ next_value: sql`next_value + 1`, last_issue_date: issueDate })
      .where('emission_point_id', '=', emissionPointId)
      .where('environment', '=', environment)
      .where('document_type', '=', documentType)
      .execute();
    return nextValue;
  }

  /** Fija el próximo secuencial de un contador que todavía no ha emitido ningún comprobante. */
  set(
    access: TenantAccess,
    emissionPointId: string,
    environment: string,
    documentType: string,
    nextValue: number,
  ): Promise<SequenceView> {
    access.requireWrite();
    return this.db.transaction().execute(async (trx) => {
      const point = await trx
        .selectFrom('emission_points')
        .select('id')
        .where('id', '=', emissionPointId)
        .where('tenant_id', '=', access.tenantId)
        .executeTakeFirst();
      if (point === undefined) throw ApiException.notFound();
      // El upsert toma el bloqueo del contador antes de mirar si ya se usó: una emisión en curso
      // termina primero y su comprobante ya es visible para la comprobación siguiente.
      await trx
        .insertInto('document_sequences')
        .values({
          tenant_id: access.tenantId,
          emission_point_id: emissionPointId,
          environment,
          document_type: documentType,
          next_value: nextValue,
        })
        .onConflict((oc) =>
          oc
            .columns(['emission_point_id', 'environment', 'document_type'])
            .doUpdateSet({ next_value: (eb) => eb.ref('excluded.next_value') }),
        )
        .execute();
      const used = await trx
        .selectFrom('fiscal_documents')
        .select(sql<string>`count(*)`.as('n'))
        .where('emission_point_id', '=', emissionPointId)
        .where('environment', '=', environment)
        .where('document_type', '=', documentType)
        .executeTakeFirstOrThrow();
      if (Number(used.n) > 0) {
        throw new ApiException(
          409,
          'SEQUENCE_ALREADY_USED',
          'El punto de emisión ya emitió comprobantes de este tipo; su secuencial no se puede cambiar',
        );
      }
      await this.audit.recordFor(trx, access, 'SEQUENCE_SET', 'EMISSION_POINT', emissionPointId, {
        environment,
        documentType,
        nextValue,
      });
      return { emissionPointId, environment, documentType, nextValue };
    });
  }
}
