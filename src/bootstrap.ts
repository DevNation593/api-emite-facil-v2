import {
  type ModuleMetadata,
  Module,
  NotFoundException,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { Logger, LoggerModule } from 'nestjs-pino';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { ApiKeyService } from './apikey/api-key.service.js';
import { RateLimiter } from './common/rate-limiter.js';
import { correlationIdMiddleware } from './common/correlation-id.middleware.js';
import { jsonBodyMiddleware } from './common/json-body.js';
import { loadConfig } from './config/app-config.js';
import { AccessTokens } from './identity/access-tokens.js';
import { authenticationMiddleware } from './identity/authentication.middleware.js';
import { inFlightMiddleware } from './observability/lifecycle.js';
import { createPinoLogger } from './observability/logging.js';
import { WorkerModule } from './orchestration/worker.module.js';

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
  const config = loadConfig(process.env);
  const logger = createPinoLogger(config);

  @Module({
    imports: [
      // Como en Java, no se registra cada petición: sin autoLogging y sin el
      // middleware de pino-http (forRoutes vacío), que además registraría una
      // ruta comodín que falsearía la detección de 405 del filtro de errores.
      LoggerModule.forRoot({
        pinoHttp: { logger, autoLogging: false },
        forRoutes: [],
        renameContext: 'logger_name',
      }),
      AppModule,
      // Aquí y no en AppModule, que es estático: la decisión necesita la configuración.
      WorkerModule.register(config.workerEnabled),
      ...(options.imports ?? []),
    ],
  })
  class RootModule {}

  const app = await NestFactory.create<NestExpressApplication>(RootModule, {
    // El parser JSON propio (límite 10mb, errores traducidos) sustituye al de Nest.
    bodyParser: false,
    // Los logs de arranque se retienen hasta conectar pino (app.useLogger).
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // Orden: el id de correlación debe existir antes de que el cuerpo pueda fallar.
  app.use(inFlightMiddleware);
  app.use(correlationIdMiddleware);
  // La autenticación va antes del cuerpo: sin credenciales no se lee ni se parsea nada. Se
  // construye con los providers ya creados porque corre fuera del ciclo de rutas de Nest.
  app.use(
    authenticationMiddleware({
      accessTokens: app.get(AccessTokens),
      apiKeys: app.get(ApiKeyService),
      limiter: app.get(RateLimiter),
    }),
  );
  app.use(jsonBodyMiddleware);
  // Nest solo monta su manejador de "no encontrado" bajo el prefijo y las rutas
  // excluidas; fuera de ellas Express respondería con HTML.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const path = req.path;
    const known =
      path === '/api/v1' ||
      path.startsWith('/api/v1/') ||
      path.startsWith('/actuator/');
    next(known ? undefined : new NotFoundException());
  });
  app.disable('etag');
  app.disable('x-powered-by');
  app.setGlobalPrefix('api/v1', { exclude: ['actuator/{*path}'] });
  return app;
}
