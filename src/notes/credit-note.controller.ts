import { Body, Controller, Headers, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { requireIdempotencyKey } from '../billing/idempotency-key.js';
import { issuedResponse, type IssuedResponse } from '../billing/invoice.controller.js';
import { requestHash } from '../billing/request-hash.js';
import { creditNoteCommand, creditNoteRequestView, IssueCreditNoteDto } from './credit-note.dto.js';
import { CreditNoteService } from './credit-note.service.js';

@Controller('credit-notes')
@UseGuards(TenantAccessGuard)
export class CreditNoteController {
  constructor(
    private readonly service: CreditNoteService,
    @Inject(DATABASE) private readonly db: Kysely<DB>,
  ) {}

  /**
   * Acepta la nota para procesamiento: RESERVED no es todavía un comprobante autorizado. La cabecera se
   * comprueba después de validar el cuerpo, como en Java (e3.json).
   */
  @Post()
  @HttpCode(202)
  async issue(
    @Tenant() access: TenantAccess,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() request: IssueCreditNoteDto,
  ): Promise<IssuedResponse> {
    requireIdempotencyKey(idempotencyKey);
    const id = await this.service.issue(
      access,
      idempotencyKey,
      requestHash(creditNoteRequestView(request)),
      creditNoteCommand(request),
    );
    return issuedResponse(this.db, access, id);
  }
}
