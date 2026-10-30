import { type ModuleMetadata, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

export interface CreateAppOptions {
  /** Módulos extra (p. ej. controladores de prueba) que se suman a AppModule. */
  imports?: ModuleMetadata['imports'];
}

/**
 * Crea la aplicación sin escuchar en ningún puerto, para poder reutilizarla
 * en main.ts y en las pruebas. /actuator/* queda en la raíz, sin prefijo.
 */
export async function createApp(
  options: CreateAppOptions = {},
): Promise<NestExpressApplication> {
  @Module({ imports: [AppModule, ...(options.imports ?? [])] })
  class RootModule {}

  const app = await NestFactory.create<NestExpressApplication>(RootModule, {
    // Vitest fija NODE_ENV=test; sin esto cada prueba imprime el arranque de Nest.
    logger: process.env.NODE_ENV === 'test' ? false : ['error', 'warn', 'log'],
  });
  app.setGlobalPrefix('api/v1', { exclude: ['actuator/{*path}'] });
  return app;
}
