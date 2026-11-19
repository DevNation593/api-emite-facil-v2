import { Controller, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import { OutboxWriter } from '../billing/outbox-writer.js';
import { ApiException } from '../common/api-exception.js';
import { UuidPipe } from '../common/uuid.pipe.js';
import { AuditLog } from '../compliance/audit-log.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { RECEIVED, SENDING } from './document-pipeline.js';
import { GENERATED, RESERVED, SIGNATURE_FAILED, SIGNED } from './document-processor.js';

export const RETRY_REQUESTED = 'DOCUMENT_RETRY_REQUESTED';

/** Estados desde los que el pipeline tiene algo que hacer. Los rechazos del SRI no se reintentan tal cual. */
const RETRYABLE = new Set([RESERVED, GENERATED, SIGNATURE_FAILED, SIGNED, SENDING, RECEIVED]);

export interface RetryAccepted {
  id: string;
  state: string;
}

/**
 * Reintento manual de un comprobante que quedó a medio camino, como orchestration/DocumentRetryController.java:
 * sin firmar por falta de certificado, o sin respuesta definitiva del SRI tras agotar los reintentos
 * automáticos. No cambia el estado: devuelve el documento a la cola para que el worker lo retome donde está.
 */
@Controller('documents/:id/retry')
@UseGuards(TenantAccessGuard)
export class DocumentRetryController {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly documents: FiscalDocumentRepository,
    private readonly outbox: OutboxWriter,
    private readonly audit: AuditLog,
  ) {}

  @Post()
  @HttpCode(202)
  retry(@Tenant() access: TenantAccess, @Param('id', UuidPipe) id: string): Promise<RetryAccepted> {
    access.requireBilling();
    return this.db.transaction().execute(async (trx) => {
      const locked = await this.documents.lockForProcessing(trx, access.tenantId, id);
      if (locked === null) throw ApiException.notFound();
      if (!RETRYABLE.has(locked.state)) {
        throw new ApiException(409, 'DOCUMENT_NOT_RETRYABLE', 'El comprobante está en un estado que no admite reintento');
      }
      await this.documents.schedule(trx, access.tenantId, id, 0, 0);
      await this.outbox.write(trx, access.tenantId, id, RETRY_REQUESTED, { documentId: id });
      await this.audit.recordFor(trx, access, RETRY_REQUESTED, 'FISCAL_DOCUMENT', id, { state: locked.state });
      return { id, state: locked.state };
    });
  }
}
