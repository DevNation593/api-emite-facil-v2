import { Global, Module } from '@nestjs/common';
import { Registry } from 'prom-client';

/** Token del registro de métricas de la aplicación (el endpoint Prometheus llega en E6). */
export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');

/**
 * Registro propio, no el global de prom-client: así cada aplicación (y cada prueba) tiene sus
 * contadores y no se duplican al crear la aplicación varias veces en un mismo proceso.
 */
@Global()
@Module({
  providers: [{ provide: METRICS_REGISTRY, useFactory: () => new Registry() }],
  exports: [METRICS_REGISTRY],
})
export class MetricsModule {}
