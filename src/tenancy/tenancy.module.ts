import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditLog } from '../compliance/audit-log.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { TenantAccessGuard } from './tenant-access.guard.js';
import { TenantController } from './tenant.controller.js';
import { TenantService } from './tenant.service.js';

/**
 * Empresas y empresa activa. Un módulo de dominio importa este y usa
 * `@UseGuards(TenantAccessGuard)` con `@Tenant()`: reexporta DatabaseModule porque el guard se
 * instancia en el módulo que lo usa y necesita inyectar DATABASE.
 */
@Module({
  imports: [DatabaseModule, ComplianceModule],
  controllers: [TenantController],
  providers: [
    TenantAccessGuard,
    {
      provide: TenantService,
      useFactory: (db: Kysely<DB>, audit: AuditLog) => new TenantService(db, audit),
      inject: [DATABASE, AuditLog],
    },
  ],
  exports: [DatabaseModule, TenantAccessGuard, TenantService],
})
export class TenancyModule {}
