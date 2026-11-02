import { createHash } from 'node:crypto';
import net from 'node:net';
import { Redis } from 'ioredis';
import { Registry } from 'prom-client';
import { RateLimiter } from '../../../src/common/rate-limiter.js';
import { createRedis } from '../../../src/infrastructure/redis.module.js';
import { startRedis, type RedisHandle } from '../../support/containers.js';

const LIMITS = { requestsPerMinute: 1200, writesPerMinute: 300 };

let handle: RedisHandle;
let admin: Redis;
const opened: Redis[] = [];

beforeAll(async () => {
  handle = await startRedis();
  admin = new Redis(handle.redisUrl);
}, 120_000);

afterAll(async () => {
  opened.forEach((r) => r.disconnect());
  admin?.disconnect();
  await handle?.stop();
});

function client(url: string, timeoutMs: number): Redis {
  const redis = createRedis({ url, timeoutMs });
  opened.push(redis);
  return redis;
}

it('crea las claves de Java con el resumen SHA-256 y TTL de hasta 120 s', async () => {
  const limiter = new RateLimiter(
    client(handle.redisUrl, 2_000),
    LIMITS,
    new Registry(),
  );
  expect(await limiter.check('usuario-1', true)).toEqual({
    allowed: true,
    retryAfterSeconds: 0,
  });

  const digest = createHash('sha256')
    .update('usuario-1')
    .digest('hex')
    .slice(0, 32);
  const keys = (await admin.keys('einvoice:rl:*')).sort();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(new RegExp(`^einvoice:rl:r:${digest}:[0-9]+$`));
  expect(keys[1]).toMatch(new RegExp(`^einvoice:rl:w:${digest}:[0-9]+$`));
  for (const key of keys) {
    const ttl = await admin.ttl(key);
    expect(ttl).toBeGreaterThanOrEqual(1);
    expect(ttl).toBeLessThanOrEqual(120);
  }
});

it('con Redis colgado resuelve allowed: true en menos de 1 s', async () => {
  // Servidor que acepta la conexión TCP y nunca responde: un Redis colgado.
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as net.AddressInfo;
    const registry = new Registry();
    const limiter = new RateLimiter(
      client(`redis://127.0.0.1:${port}`, 500),
      LIMITS,
      registry,
    );
    const started = Date.now();
    const decision = await limiter.check('colgado', false);
    expect(decision.allowed).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => server.close(resolve));
  }
});
