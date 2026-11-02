import { createHash } from 'node:crypto';
import net from 'node:net';
import { Redis } from 'ioredis';
import { testConfig } from '../../support/test-env.js';
import { AuthAttemptLimiter } from '../../../src/identity/auth-attempt-limiter.js';
import { createRedis } from '../../../src/infrastructure/redis.module.js';
import { startRedis, type RedisHandle } from '../../support/containers.js';

const auth = testConfig.auth;
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

beforeEach(async () => {
  await admin.flushall();
});

function client(url: string, timeoutMs = 2_000): Redis {
  const redis = createRedis({ url, timeoutMs });
  opened.push(redis);
  return redis;
}

const digest = (v: string) =>
  createHash('sha256').update(v).digest('hex').slice(0, 32);

it('el fallo número 5 bloquea y devuelve 900; las claves y TTL son los de Java', async () => {
  const limiter = new AuthAttemptLimiter(client(handle.redisUrl), auth);
  const d = digest('a@b.ec');
  for (let i = 1; i <= 4; i++) {
    expect(await limiter.recordFailure('a@b.ec')).toBe(0);
  }
  expect(await limiter.lockedFor('a@b.ec')).toBe(0);
  expect(await admin.ttl(`einvoice:auth:fail:${d}`)).toBeGreaterThan(890);

  expect(await limiter.recordFailure('a@b.ec')).toBe(900);
  expect(await admin.exists(`einvoice:auth:fail:${d}`)).toBe(0);
  expect(await admin.get(`einvoice:auth:lock:${d}`)).toBe('1');
  const ttl = await admin.ttl(`einvoice:auth:lock:${d}`);
  expect(ttl).toBeGreaterThan(890);
  expect(ttl).toBeLessThanOrEqual(900);
  const locked = await limiter.lockedFor('a@b.ec');
  expect(locked).toBeGreaterThan(890);
  expect(locked).toBeLessThanOrEqual(900);
});

it('recordSuccess borra los fallos', async () => {
  const limiter = new AuthAttemptLimiter(client(handle.redisUrl), auth);
  await limiter.recordFailure('c@d.ec');
  await limiter.recordFailure('c@d.ec');
  await limiter.recordSuccess('c@d.ec');
  expect(await admin.exists(`einvoice:auth:fail:${digest('c@d.ec')}`)).toBe(0);
  for (let i = 1; i <= 4; i++) {
    expect(await limiter.recordFailure('c@d.ec')).toBe(0);
  }
});

it('la petición 21 de una IP en la ventana da retryAfter > 0; clave con TTL 120', async () => {
  const limiter = new AuthAttemptLimiter(
    client(handle.redisUrl),
    auth,
    () => 1_700_000_010_000,
  );
  for (let i = 1; i <= 20; i++) {
    expect(await limiter.ipRetryAfter('1.2.3.4')).toBe(0);
  }
  expect(await limiter.ipRetryAfter('1.2.3.4')).toBe(60 - (1_700_000_010 % 60));
  const keys = await admin.keys('einvoice:auth:ip:*');
  expect(keys).toEqual([
    `einvoice:auth:ip:${digest('1.2.3.4')}:${Math.floor(1_700_000_010 / 60)}`,
  ]);
  const ttl = await admin.ttl(keys[0] as string);
  expect(ttl).toBeGreaterThan(110);
  expect(ttl).toBeLessThanOrEqual(120);
});

it('con Redis colgado devuelve 0 en menos de 1 s y descansa', async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => sockets.push(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as net.AddressInfo;
    const limiter = new AuthAttemptLimiter(
      client(`redis://127.0.0.1:${port}`, 500),
      auth,
    );
    const started = Date.now();
    expect(await limiter.recordFailure('x@y.ec')).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
    const second = Date.now();
    expect(await limiter.ipRetryAfter('1.1.1.1')).toBe(0);
    expect(await limiter.lockedFor('x@y.ec')).toBe(0);
    expect(Date.now() - second).toBeLessThan(100);
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
  }
});
