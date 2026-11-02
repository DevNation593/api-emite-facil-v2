import { Module } from '@nestjs/common';
import { ApiKeyModule } from './apikey/apikey.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { CommonModule } from './common/common.module.js';
import { ConfigModule } from './config/config.module.js';
import { RateLimiterModule } from './common/rate-limiter.js';
import { ComplianceModule } from './compliance/compliance.module.js';
import { DatabaseModule } from './database/database.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { SequenceModule } from './sequence/sequence.module.js';
import { TaxpayerModule } from './taxpayer/taxpayer.module.js';
import { TenancyModule } from './tenancy/tenancy.module.js';
import { HealthModule } from './observability/health.controller.js';

// Raíz de la aplicación. Los módulos de dominio se irán importando aquí.
@Module({ imports: [
    ApiKeyModule,
    CatalogModule,
    CommonModule,
    ComplianceModule,
    ConfigModule,
    DatabaseModule,
    HealthModule,
    IdentityModule,
    RateLimiterModule,
    SequenceModule,
    TaxpayerModule,
    TenancyModule,
  ] })
export class AppModule {}
