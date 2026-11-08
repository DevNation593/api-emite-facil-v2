import { Body, Controller, Headers, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { requireIdempotencyKey } from '../billing/idempotency-key.js';
import { issuedResponse, type IssuedResponse } from '../billing/invoice.controller.js';
import { requestHash } from '../billing/request-hash.js';
import { debitNoteCommand, debitNoteRequestView, IssueDebitNoteDto } from './debit-note.dto.js';
import { DebitNoteService } from './debit-note.service.js';

@Controller('debit-notes')
@UseGuards(TenantAccessGuard)
export class DebitNoteController {
  constructor(
    private readonly service: DebitNoteService,
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
    @Body() request: IssueDebitNoteDto,
  ): Promise<IssuedResponse> {
    requireIdempotencyKey(idempotencyKey);
    const id = await this.service.issue(
      access,
      idempotencyKey,
      requestHash(debitNoteRequestView(request)),
      debitNoteCommand(request),
    );
    return issuedResponse(this.db, access, id);
  }
}
