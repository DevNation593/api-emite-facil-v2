import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config/app-config.js';
import {
  ensureRedisReady,
  withRedisTimeout,
} from '../infrastructure/redis.module.js';

const WINDOW_SECONDS = 60;
/** Tras un fallo de Redis no se le vuelve a preguntar durante este tiempo. */
const REST_AFTER_FAILURE_MS = 10_000;

/**
 * Freno contra quien prueba contraseñas: bloquea un correo tras varios fallos seguidos y limita
 * cuántas peticiones públicas hace una IP por minuto. Vive en Redis con las claves de la API
 * Java; si Redis no responde se deja pasar (Argon2 sigue haciendo lento cada intento).
 */
export class AuthAttemptLimiter {
  private readonly logger = new Logger(AuthAttemptLimiter.name);
  private restingUntil = 0;

  constructor(
    private readonly redis: Redis,
    private readonly auth: Pick<
      AppConfig['auth'],
      'maxLoginFailures' | 'lockoutMs' | 'publicRequestsPerMinute'
    >,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Segundos que faltan para que la IP pueda volver a llamar; 0 si puede ahora. Cuenta la petición. */
  ipRetryAfter(ip: string): Promise<number> {
    const now = Math.floor(this.clock() / 1000);
    return this.guarded(async () => {
      const key = `einvoice:auth:ip:${digest(ip)}:${Math.floor(now / WINDOW_SECONDS)}`;
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, WINDOW_SECONDS * 2);
      return count > this.auth.publicRequestsPerMinute
        ? WINDOW_SECONDS - (now % WINDOW_SECONDS)
        : 0;
    });
  }

  /** Segundos que le quedan de bloqueo al correo; 0 si no está bloqueado. */
  lockedFor(email: string): Promise<number> {
    return this.guarded(async () => {
      // TTL devuelve -1 sin caducidad y -2 si no existe: ambos cuentan como no bloqueado.
      const ttl = await this.redis.ttl(lockKey(email));
      return ttl > 0 ? ttl : 0;
    });
  }

  /** Anota un fallo del correo; al llegar al máximo lo bloquea y dice durante cuántos segundos. */
  recordFailure(email: string): Promise<number> {
    return this.guarded(async () => {
      const key = failuresKey(email);
      const failures = await this.redis.incr(key);
      if (failures === 1) await this.redis.pexpire(key, this.auth.lockoutMs);
      if (failures >= this.auth.maxLoginFailures) {
        await this.redis.set(lockKey(email), '1', 'PX', this.auth.lockoutMs);
        await this.redis.del(key);
        return Math.floor(this.auth.lockoutMs / 1000);
      }
      return 0;
    });
  }

  /** Un ingreso correcto borra los fallos anteriores del correo. */
  async recordSuccess(email: string): Promise<void> {
    await this.guarded(async () => {
      await this.redis.del(failuresKey(email));
      return 0;
    });
  }

  private async guarded(action: () => Promise<number>): Promise<number> {
    const millis = this.clock();
    if (millis < this.restingUntil) return 0;
    try {
      return await withRedisTimeout(this.redis, async () => {
        await ensureRedisReady(this.redis);
        return action();
      });
    } catch (error) {
      this.restingUntil = millis + REST_AFTER_FAILURE_MS;
      // Solo el nombre del error: el mensaje podría arrastrar la URL con contraseña.
      this.logger.warn(
        `Límite de intentos de ingreso sin aplicar, Redis no responde: ${error instanceof Error ? error.name : 'error'}`,
      );
      return 0;
    }
  }
}

function failuresKey(email: string): string {
  return `einvoice:auth:fail:${digest(email)}`;
}

function lockKey(email: string): string {
  return `einvoice:auth:lock:${digest(email)}`;
}

/** Las claves no llevan el correo ni la IP tal cual. */
function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}
