import {
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

/** Token de inyección del cliente ioredis. */
export const REDIS = Symbol('REDIS');

const QUIT_GRACE_MS = 1_000;

/**
 * Cliente perezoso: no conecta hasta la primera comprobación (ensureRedisReady), así que crear
 * la aplicación no necesita Redis. Sin cola offline, un comando con Redis caído falla al
 * instante en vez de acumularse; y connectTimeout/commandTimeout acotan cada operación.
 */
export function createRedis(config: AppConfig['redis']): Redis {
  const redis = new Redis(config.url, {
    lazyConnect: true,
    connectTimeout: config.timeoutMs,
    commandTimeout: config.timeoutMs,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  const logger = new Logger('Redis');
  // Sin oyente de 'error', ioredis tumbaría el proceso con Redis caído. La URL puede llevar
  // contraseña: solo se registra el código del error.
  redis.on('error', (error: Error & { code?: string }) => {
    logger.warn(`Error de Redis: ${error.code ?? error.name}`);
  });
  return redis;
}

/**
 * Deja el cliente listo para un comando: conecta si aún no lo hizo y, si hay una conexión o
 * reconexión en marcha, espera a que termine. El llamador acota el tiempo total.
 */
export async function ensureRedisReady(redis: Redis): Promise<void> {
  if (redis.status === 'ready') return;
  if (redis.status === 'wait' || redis.status === 'end') {
    await redis.connect();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      redis.off('ready', onReady);
      redis.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => done();
    const onClose = () => done(new Error('Redis: conexión cerrada'));
    redis.once('ready', onReady);
    redis.once('close', onClose);
  });
}

@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: (config: AppConfig) => createRedis(config.redis),
      inject: [APP_CONFIG],
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end') return;
    // quit() cierra con cortesía; si Redis no contesta, se corta el socket.
    const timer = setTimeout(() => this.redis.disconnect(), QUIT_GRACE_MS);
    timer.unref();
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    } finally {
      clearTimeout(timer);
    }
  }
}
