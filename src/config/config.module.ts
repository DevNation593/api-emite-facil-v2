import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './app-config.js';

/**
 * La configuración se valida al crear la aplicación (no al importar el módulo):
 * una variable mal puesta detiene el arranque con un mensaje que la nombra.
 */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
