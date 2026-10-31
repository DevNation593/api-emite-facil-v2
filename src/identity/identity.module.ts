import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import type { Registry } from 'prom-client';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { REDIS, RedisModule } from '../infrastructure/redis.module.js';
import { METRICS_REGISTRY, MetricsModule } from '../observability/metrics.js';
import { AccessTokens } from './access-tokens.js';
import { AuthAttemptLimiter } from './auth-attempt-limiter.js';
import { AuthMailer } from './auth-mailer.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { Passwords } from './passwords.js';

/**
 * Identidad: cuentas, sesiones y tokens de acceso. Las clases se registran con fábricas: ninguna
 * conecta con la base, Redis ni SMTP al crearse (la aplicación arranca sin infraestructura).
 */
@Module({
  imports: [DatabaseModule, RedisModule, MetricsModule],
  controllers: [AuthController],
  providers: [
    { provide: Passwords, useFactory: () => new Passwords() },
    {
      provide: AccessTokens,
      useFactory: (config: AppConfig) => new AccessTokens(config.auth),
      inject: [APP_CONFIG],
    },
    {
      provide: AuthAttemptLimiter,
      useFactory: (redis: Redis, config: AppConfig) =>
        new AuthAttemptLimiter(redis, config.auth),
      inject: [REDIS, APP_CONFIG],
    },
    {
      provide: AuthMailer,
      useFactory: (config: AppConfig) => new AuthMailer(config.mail),
      inject: [APP_CONFIG],
    },
    {
      provide: AuthService,
      useFactory: (
        db: Kysely<DB>,
        passwords: Passwords,
        accessTokens: AccessTokens,
        limiter: AuthAttemptLimiter,
        mailer: AuthMailer,
        config: AppConfig,
        registry: Registry,
      ) =>
        new AuthService(db, passwords, accessTokens, limiter, mailer, config.auth, registry),
      inject: [
        DATABASE,
        Passwords,
        AccessTokens,
        AuthAttemptLimiter,
        AuthMailer,
        APP_CONFIG,
        METRICS_REGISTRY,
      ],
    },
  ],
  exports: [AuthService, AccessTokens, Passwords],
})
export class IdentityModule implements OnApplicationShutdown {
  constructor(@Inject(AuthMailer) private readonly mailer: AuthMailer) {}

  onApplicationShutdown(): void {
    this.mailer.close();
  }
}
