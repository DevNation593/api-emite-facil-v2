import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import { ApiException } from '../common/api-exception.js';
import { UuidPipe } from '../common/uuid.pipe.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { type AttemptView, SriAttemptLog } from './sri-attempt-log.js';

/**
 * Intentos de un comprobante ante el SRI, con los mensajes que devolvió, como sri/SriAttemptController.java.
 * Es lo que mira un operador para saber por qué un comprobante no avanza. Nunca expone la respuesta cruda.
 */
@Controller('documents/:id/sri-attempts')
@UseGuards(TenantAccessGuard)
export class SriAttemptController {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly documents: FiscalDocumentRepository,
    private readonly attempts: SriAttemptLog,
  ) {}

  @Get()
  list(@Tenant() access: TenantAccess, @Param('id', UuidPipe) id: string): Promise<AttemptView[]> {
    return this.db
      .transaction()
      .setAccessMode('read only')
      .execute(async (trx) => {
        if ((await this.documents.processingState(trx, access.tenantId, id)) === null) throw ApiException.notFound();
        // Las propiedades en el orden de SriAttemptView de Java; la respuesta cruda no está en la vista.
        return (await this.attempts.list(trx, access.tenantId, id)).map((attempt) => ({
          id: attempt.id,
          operation: attempt.operation,
          outcome: attempt.outcome,
          sriStatus: attempt.sriStatus,
          httpStatus: attempt.httpStatus,
          startedAt: attempt.startedAt,
          completedAt: attempt.completedAt,
          messages: attempt.messages.map((m) => ({
            identifier: m.identifier,
            message: m.message,
            additionalInfo: m.additionalInfo,
            type: m.type,
          })),
        }));
      });
  }
}
