import { Module } from '@nestjs/common';
import type { Registry } from 'prom-client';
import { METRICS_REGISTRY } from '../observability/metrics.js';
import { XsdValidator } from './xsd-validator.js';

/** Validación XSD de los comprobantes; las reglas del sobre son funciones puras de `envelope-rules.ts`. */
@Module({
  providers: [
    {
      provide: XsdValidator,
      useFactory: (registry: Registry) => new XsdValidator({ registry }),
      inject: [METRICS_REGISTRY],
    },
  ],
  exports: [XsdValidator],
})
export class XmlModule {}
