import { Controller, Get, Inject, Module, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sql, type Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import {
  RabbitConnection,
  RabbitModule,
} from '../infrastructure/rabbit.module.js';
import {
  ensureRedisReady,
  REDIS,
  RedisModule,
} from '../infrastructure/redis.module.js';
import { checkHealth, type HealthCheck } from './health.js';
import { readiness } from './lifecycle.js';

/** Plazo de la base y de RabbitMQ; el de Redis es REDIS_TIMEOUT. */
const CHECK_TIMEOUT_MS = 2_000;
const GROUPS = ['liveness', 'readiness'];
// Mismo tipo de contenido que Spring Boot Actuator.
const ACTUATOR_TYPE = 'application/vnd.spring-boot.actuator.v3+json';

function send(res: Response, status: number, body: unknown): void {
  res.status(status);
  res.setHeader('Content-Type', ACTUATOR_TYPE);
  res.end(JSON.stringify(body));
}

/**
 * Equivalente a Spring Boot Actuator con show-details: never y probes activadas. Va en la
 * raíz (sin /api/v1): Cloud Run y la pila de pruebas sondean estas rutas exactas.
 */
@Controller('actuator/health')
export class HealthController {
  private readonly checks: HealthCheck[];

  constructor(
    @Inject(DATABASE) db: Kysely<DB>,
    @Inject(REDIS) redis: Redis,
    rabbit: RabbitConnection,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.checks = [
      {
        name: 'db',
        timeoutMs: CHECK_TIMEOUT_MS,
        run: async () => {
          await sql`SELECT 1`.execute(db);
        },
      },
      {
        name: 'rabbit',
        timeoutMs: CHECK_TIMEOUT_MS,
        run: () => rabbit.ensureOpen(),
      },
      {
        name: 'redis',
        timeoutMs: config.redis.timeoutMs,
        run: async () => {
          await ensureRedisReady(redis);
          await redis.ping();
        },
      },
    ];
  }

  @Get()
  async health(@Res() res: Response): Promise<void> {
    const status = await checkHealth(this.checks);
    send(res, status === 'UP' ? 200 : 503, { status, groups: GROUPS });
  }

  @Get('liveness')
  liveness(@Res() res: Response): void {
    send(res, 200, { status: 'UP' });
  }

  @Get('readiness')
  readiness(@Res() res: Response): void {
    const status = readiness.state();
    send(res, status === 'UP' ? 200 : 503, { status });
  }
}

@Module({
  imports: [DatabaseModule, RedisModule, RabbitModule],
  controllers: [HealthController],
})
export class HealthModule {}
