import { createHash } from 'node:crypto';
import { Logger, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Counter, type Registry } from 'prom-client';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import {
  ensureRedisReady,
  REDIS,
  RedisModule,
  withRedisTimeout,
} from '../infrastructure/redis.module.js';
import { METRICS_REGISTRY, MetricsModule } from '../observability/metrics.js';

const WINDOW_SECONDS = 60;
/** El contador sobrevive a su ventana lo justo para no perderse por un desfase de relojes. */
const KEY_LIFETIME_SECONDS = 2 * WINDOW_SECONDS;
/** Tras un fallo de Redis no se le vuelve a preguntar durante este tiempo. */
const REST_AFTER_FAILURE_MS = 10_000;

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Límite de peticiones por usuario en ventanas de un minuto contadas en Redis (valen entre
 * instancias), con las mismas claves que la API Java. Las escrituras tienen además su propio
 * tope. Si Redis no responde la petición pasa: un fallo del contador no debe dejar a nadie sin
 * facturar; y tras un fallo se le deja descansar para que un Redis colgado cueste una espera
 * corta y no una por petición.
 */
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);
  private readonly unavailable: Counter;
  private restingUntil = 0;

  constructor(
    private readonly redis: Redis,
    private readonly limits: AppConfig['rateLimit'],
    registry: Registry,
    private readonly clock: () => number = Date.now,
  ) {
    this.unavailable = new Counter({
      name: 'einvoice_ratelimit_unavailable_total',
      help: 'Peticiones que pasaron sin contarse porque Redis no respondió',
      registers: [registry],
    });
  }

  async check(subject: string, write: boolean): Promise<RateDecision> {
    const millis = this.clock();
    if (millis < this.restingUntil) {
      // Redis acaba de fallar: cada petición no vuelve a esperar a que agote su plazo.
      this.unavailable.inc();
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const now = Math.floor(millis / 1000);
    const window = Math.floor(now / WINDOW_SECONDS);
    const user = digest(subject);
    const rejected = {
      allowed: false,
      retryAfterSeconds: WINDOW_SECONDS - (now % WINDOW_SECONDS),
    };
    try {
      return await withRedisTimeout(this.redis, async () => {
        await ensureRedisReady(this.redis);
        // Una escritura rechazada no gasta además el cupo general.
        if (
          write &&
          (await this.count(`w:${user}:${window}`)) >
            this.limits.writesPerMinute
        ) {
          return rejected;
        }
        if (
          (await this.count(`r:${user}:${window}`)) >
          this.limits.requestsPerMinute
        ) {
          return rejected;
        }
        return { allowed: true, retryAfterSeconds: 0 };
      });
    } catch (error) {
      this.restingUntil = millis + REST_AFTER_FAILURE_MS;
      this.unavailable.inc();
      // Solo el nombre del error: el mensaje podría arrastrar la URL con contraseña.
      this.logger.debug(
        `Límite de peticiones sin aplicar, Redis no responde: ${error instanceof Error ? error.name : 'error'}`,
      );
      return { allowed: true, retryAfterSeconds: 0 };
    }
  }

  private async count(suffix: string): Promise<number> {
    const key = `einvoice:rl:${suffix}`;
    const value = await this.redis.incr(key);
    if (value === 1) await this.redis.expire(key, KEY_LIFETIME_SECONDS);
    return value;
  }
}

/** La clave no lleva el identificador del usuario tal cual. */
function digest(subject: string): string {
  return createHash('sha256')
    .update(subject, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/** Provider para inyectarlo (el guard de E1 lo usa). */
@Module({
  imports: [RedisModule, MetricsModule],
  providers: [
    {
      provide: RateLimiter,
      useFactory: (redis: Redis, config: AppConfig, registry: Registry) =>
        new RateLimiter(redis, config.rateLimit, registry),
      inject: [REDIS, APP_CONFIG, METRICS_REGISTRY],
    },
  ],
  exports: [RateLimiter],
})
export class RateLimiterModule {}
