import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import { OutboxWriter } from '../billing/outbox-writer.js';
import { ApiException } from '../common/api-exception.js';
import { strip } from '../common/java-text.js';
import { UuidPipe } from '../common/uuid.pipe.js';
import { AuditLog } from '../compliance/audit-log.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { validAddress } from './delivery-config.js';
import { DeliveryRequestDto } from './delivery.dto.js';
import { DeliveryRepository, type DeliveryRow } from './delivery.repository.js';
import { hasAutomaticDelivery } from './delivery.service.js';

export const DELIVERY_REQUESTED = 'DELIVERY_REQUESTED';

const AUTHORIZED = 'AUTHORIZED';

export interface DeliveryView {
  id: string;
  channel: string;
  recipient: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  automatic: boolean;
}

function viewOf(row: DeliveryRow): DeliveryView {
  return {
    id: row.id,
    channel: row.channel,
    recipient: row.recipient,
    status: row.status,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
    automatic: row.requestedBy === null,
  };
}

/**
 * Entregas de un comprobante al receptor, como delivery/DeliveryController.java: consulta de lo enviado y petición
 * de un nuevo envío, a la dirección del cliente o a otra. El envío lo hace el worker; aquí solo se registra la
 * petición.
 */
@Controller('documents/:id/deliveries')
@UseGuards(TenantAccessGuard)
export class DeliveryController {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly documents: FiscalDocumentRepository,
    private readonly deliveries: DeliveryRepository,
    private readonly outbox: OutboxWriter,
    private readonly audit: AuditLog,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  list(@Tenant() access: TenantAccess, @Param('id', UuidPipe) id: string): Promise<DeliveryView[]> {
    return this.db
      .transaction()
      .setAccessMode('read only')
      .execute(async (trx) => {
        if ((await this.documents.processingState(trx, access.tenantId, id)) === null) throw ApiException.notFound();
        return (await this.deliveries.list(trx, access.tenantId, id)).map(viewOf);
      });
  }

  @Post()
  @HttpCode(202)
  request(
    @Tenant() access: TenantAccess,
    @Param('id', UuidPipe) id: string,
    // Sin `| null`: TypeScript emitiría Object como tipo y el cuerpo no se validaría. Sin cuerpo llega null.
    @Body() request: DeliveryRequestDto,
  ): Promise<DeliveryView> {
    access.requireBilling();
    const { delivery } = this.config;
    return this.db.transaction().execute(async (trx) => {
      // El bloqueo ordena peticiones simultáneas: el tope por comprobante no se puede superar a la vez.
      const locked = await this.documents.lockForProcessing(trx, access.tenantId, id);
      if (locked === null) throw ApiException.notFound();
      if (locked.state !== AUTHORIZED) {
        throw new ApiException(409, 'DOCUMENT_NOT_AUTHORIZED', 'Solo se entrega un comprobante autorizado');
      }
      if (!delivery.email.enabled) {
        throw new ApiException(409, 'DELIVERY_DISABLED', 'El envío de comprobantes por correo no está habilitado');
      }
      const requested = strip((request as DeliveryRequestDto | null)?.email ?? '');
      const customerEmail = await this.documents.customerEmail(trx, access.tenantId, id);
      const recipient = requested === '' ? strip(customerEmail ?? '') : requested;
      if (recipient === '') {
        throw new ApiException(
          422,
          'DELIVERY_RECIPIENT_MISSING',
          'El comprobante no tiene correo del cliente: indique una dirección',
        );
      }
      if (!validAddress(recipient)) {
        throw new ApiException(400, 'MALFORMED_REQUEST', 'La dirección de correo no es válida');
      }
      // La entrega automática que el worker aún no ha creado también cuenta: se le guarda el sitio.
      const reserved = hasAutomaticDelivery(customerEmail) && !(await this.deliveries.hasAutomatic(trx, id)) ? 1 : 0;
      if ((await this.deliveries.count(trx, id)) + reserved >= delivery.maxPerDocument) {
        throw new ApiException(409, 'DELIVERY_LIMIT_REACHED', 'El comprobante alcanzó el máximo de entregas');
      }
      const deliveryId = await this.deliveries.create(trx, access.tenantId, id, recipient, access.userId);
      await this.outbox.write(trx, access.tenantId, id, DELIVERY_REQUESTED, { documentId: id });
      // La dirección no va a la auditoría: es un dato del cliente y ya consta en la entrega.
      await this.audit.recordFor(trx, access, DELIVERY_REQUESTED, 'FISCAL_DOCUMENT', id, { deliveryId });
      return viewOf((await this.deliveries.find(trx, access.tenantId, deliveryId))!);
    });
  }
}
