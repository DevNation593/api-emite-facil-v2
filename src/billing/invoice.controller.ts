import { Body, Controller, Headers, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { FiscalDocumentRepository } from './fiscal-document.repository.js';
import { requireIdempotencyKey } from './idempotency-key.js';
import { invoiceCommand, invoiceRequestView, IssueInvoiceDto } from './invoice.dto.js';
import { InvoiceService } from './invoice.service.js';
import { requestHash } from './request-hash.js';

/** Respuesta 202 de toda emisión: el id, el estado actual y dónde consultarlo. */
export interface IssuedResponse {
  id: string;
  state: string;
  statusUrl: string;
}

const documents = new FiscalDocumentRepository();

/** En un reintento el documento puede haber avanzado: se informa su estado actual, ya confirmado. */
export async function issuedResponse(
  db: Kysely<DB> | Transaction<DB>,
  access: TenantAccess,
  id: string,
): Promise<IssuedResponse> {
  const document = await documents.find(db, access.tenantId, id);
  if (document === null) throw ApiException.notFound();
  return { id, state: document.state, statusUrl: `/api/v1/documents/${id}` };
}

@Controller('invoices')
@UseGuards(TenantAccessGuard)
export class InvoiceController {
  constructor(
    private readonly service: InvoiceService,
    @Inject(DATABASE) private readonly db: Kysely<DB>,
  ) {}

  /**
   * Acepta la factura para procesamiento: RESERVED no es todavía un comprobante autorizado. La cabecera
   * se comprueba después de validar el cuerpo, como en Java (e3.json).
   */
  @Post()
  @HttpCode(202)
  async issue(
    @Tenant() access: TenantAccess,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() request: IssueInvoiceDto,
  ): Promise<IssuedResponse> {
    requireIdempotencyKey(idempotencyKey);
    const id = await this.service.issue(
      access,
      idempotencyKey,
      requestHash(invoiceRequestView(request)),
      invoiceCommand(request),
    );
    return issuedResponse(this.db, access, id);
  }
}
