import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditLog } from '../compliance/audit-log.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { EmissionPointController, EstablishmentController } from './establishment.controller.js';
import { EstablishmentService } from './establishment.service.js';
import { TaxpayerController } from './taxpayer.controller.js';
import { TaxpayerService } from './taxpayer.service.js';

/** Emisores, establecimientos y puntos de emisión. */
@Module({
  imports: [TenancyModule, ComplianceModule],
  controllers: [TaxpayerController, EstablishmentController, EmissionPointController],
  providers: [
    {
      provide: TaxpayerService,
      useFactory: (db: Kysely<DB>, audit: AuditLog) => new TaxpayerService(db, audit),
      inject: [DATABASE, AuditLog],
    },
    {
      provide: EstablishmentService,
      useFactory: (db: Kysely<DB>, audit: AuditLog, taxpayers: TaxpayerService) =>
        new EstablishmentService(db, audit, taxpayers),
      inject: [DATABASE, AuditLog, TaxpayerService],
    },
  ],
  exports: [TaxpayerService, EstablishmentService],
})
export class TaxpayerModule {}
