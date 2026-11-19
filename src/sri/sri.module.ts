import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { HttpSriGateway, SRI_GATEWAY } from './http-sri-gateway.js';

/** Conexión con los servicios off-line del SRI. */
@Module({
  providers: [
    {
      provide: SRI_GATEWAY,
      useFactory: (config: AppConfig) => new HttpSriGateway(config.sri),
      inject: [APP_CONFIG],
    },
  ],
  exports: [SRI_GATEWAY],
})
export class SriModule {}
