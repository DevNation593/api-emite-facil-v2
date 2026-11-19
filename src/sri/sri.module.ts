import { Module } from '@nestjs/common';
import type { Registry } from 'prom-client';
import { BillingModule } from '../billing/billing.module.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DatabaseModule } from '../database/database.module.js';
import { METRICS_REGISTRY, MetricsModule } from '../observability/metrics.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { HttpSriGateway, SRI_GATEWAY } from './http-sri-gateway.js';
import { SriAttemptController } from './sri-attempt.controller.js';
import { SriAttemptLog } from './sri-attempt-log.js';

/** Conexión con los servicios off-line del SRI, bitácora de sus llamadas y su consulta. */
@Module({
  imports: [MetricsModule, DatabaseModule, TenancyModule, BillingModule],
  controllers: [SriAttemptController],
  providers: [
    {
      provide: SRI_GATEWAY,
      useFactory: (config: AppConfig) => new HttpSriGateway(config.sri),
      inject: [APP_CONFIG],
    },
    {
      provide: SriAttemptLog,
      useFactory: (registry: Registry) => new SriAttemptLog(registry),
      inject: [METRICS_REGISTRY],
    },
  ],
  exports: [SRI_GATEWAY, SriAttemptLog],
})
export class SriModule {}
