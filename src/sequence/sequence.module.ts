import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditLog } from '../compliance/audit-log.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { SequenceController } from './sequence.controller.js';
import { SequenceService } from './sequence.service.js';

/** Secuenciales por punto de emisión, ambiente y tipo de comprobante. */
@Module({
  imports: [TenancyModule, ComplianceModule],
  controllers: [SequenceController],
  providers: [
    {
      provide: SequenceService,
      useFactory: (db: Kysely<DB>, audit: AuditLog) => new SequenceService(db, audit),
      inject: [DATABASE, AuditLog],
    },
  ],
  exports: [SequenceService],
})
export class SequenceModule {}
