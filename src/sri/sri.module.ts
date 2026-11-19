import { Module } from '@nestjs/common';
import type { Registry } from 'prom-client';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { METRICS_REGISTRY, MetricsModule } from '../observability/metrics.js';
import { HttpSriGateway, SRI_GATEWAY } from './http-sri-gateway.js';
import { SriAttemptLog } from './sri-attempt-log.js';

/** Conexión con los servicios off-line del SRI y bitácora de sus llamadas. */
@Module({
  imports: [MetricsModule],
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
