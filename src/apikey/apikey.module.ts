import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditLog } from '../compliance/audit-log.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { ApiKeyController } from './api-key.controller.js';
import { ApiKeyService } from './api-key.service.js';

/**
 * API keys: gestión por la empresa y comprobación de la key de cada petición. IdentityModule lo
 * importa porque el middleware de autenticación necesita ApiKeyService.
 */
@Module({
  imports: [TenancyModule, ComplianceModule],
  controllers: [ApiKeyController],
  providers: [
    {
      provide: ApiKeyService,
      useFactory: (db: Kysely<DB>, audit: AuditLog) => new ApiKeyService(db, audit),
      inject: [DATABASE, AuditLog],
    },
  ],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}
