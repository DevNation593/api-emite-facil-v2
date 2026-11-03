import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { type PageResponse, pageRequest } from '../common/pagination.js';
import { IntQueryPipe, OptionalStringQueryPipe } from '../common/query-params.js';
import { UuidPipe } from '../common/uuid.pipe.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { DOCUMENT_TYPES } from '../xml/document-type.js';
import {
  type DocumentParts,
  type DocumentSummary,
  type DocumentView,
  documentSummary,
  documentView,
  lineView,
  paymentView,
  taxView,
} from './document-views.js';
import { FiscalDocumentRepository } from './fiscal-document.repository.js';

const KNOWN_CODES: readonly string[] = Object.values(DOCUMENT_TYPES).map((type) => type.code);

/** Un código que no es de un tipo conocido es una petición mal formada. */
function parseType(code: string | null): string | null {
  if (code === null) return null;
  if (!KNOWN_CODES.includes(code)) {
    throw new ApiException(400, 'MALFORMED_REQUEST', 'Tipo de comprobante desconocido');
  }
  return code;
}

/** Consulta de comprobantes. Los importes salen como cadenas decimales. */
@Controller('documents')
@UseGuards(TenantAccessGuard)
export class DocumentController {
  constructor(
    private readonly documents: FiscalDocumentRepository,
    @Inject(DATABASE) private readonly db: Kysely<DB>,
  ) {}

  @Get(':id')
  async get(@Tenant() access: TenantAccess, @Param('id', UuidPipe) id: string): Promise<DocumentView> {
    const tenantId = access.tenantId;
    return this.db.transaction().setAccessMode('read only').execute(async (trx) => {
      const row = await this.documents.find(trx, tenantId, id);
      if (row === null) throw ApiException.notFound();
      const links = await this.documents.links(trx, tenantId, id);
      // Las ramas de las notas de crédito y débito (contenido propio) llegan con sus tipos; el resto, la
      // factura y la guía incluidas, sale de las tablas hijas.
      const parts: DocumentParts = {
        taxes: (await this.documents.taxes(trx, tenantId, id)).map(taxView),
        lines: (await this.documents.lines(trx, tenantId, id)).map(lineView),
        payments: (await this.documents.payments(trx, tenantId, id)).map(paymentView),
        reason: null,
        reasons: null,
      };
      const envelope = await this.documents.envelope(trx, tenantId, id);
      const creditedTotal =
        row.documentType === DOCUMENT_TYPES.INVOICE.code ? await this.documents.creditedTotal(trx, tenantId, id) : null;
      return documentView(row, links, envelope, parts, creditedTotal);
    });
  }

  /** `page` y `size` se validan antes que `documentType`. */
  @Get()
  async list(
    @Tenant() access: TenantAccess,
    @Query('page', new IntQueryPipe(0)) page: number,
    @Query('size', new IntQueryPipe(20)) size: number,
    @Query('documentType', new OptionalStringQueryPipe()) documentType: string | null,
  ): Promise<PageResponse<DocumentSummary>> {
    pageRequest(page, size);
    const type = parseType(documentType);
    const tenantId = access.tenantId;
    return this.db.transaction().setAccessMode('read only').execute(async (trx) => {
      const rows = await this.documents.page(trx, tenantId, type, page, size);
      return {
        items: rows.map(documentSummary),
        page,
        size,
        total: await this.documents.count(trx, tenantId, type),
      };
    });
  }
}
