import type { Redis } from 'ioredis';
import { Registry } from 'prom-client';
import { RateLimiter } from '../../../src/common/rate-limiter.js';

/** Redis falso en memoria: solo lo que usa el limitador. */
class FakeRedis {
  status = 'ready';
  options = { commandTimeout: 1_000 };
  calls = 0;
  failing = false;
  readonly counters = new Map<string, number>();
  readonly expires = new Map<string, number>();

  incr(key: string): Promise<number> {
    this.calls++;
    if (this.failing) return Promise.reject(new Error('Redis caído'));
    const value = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, value);
    return Promise.resolve(value);
  }

  expire(key: string, seconds: number): Promise<number> {
    this.expires.set(key, seconds);
    return Promise.resolve(1);
  }
}

// 2026-01-01T00:00:30Z: segundo 30 de su ventana de 60 s.
const START_MS = Math.floor(Date.UTC(2026, 0, 1) / 60_000) * 60_000 + 30_000;
const LIMITS = { requestsPerMinute: 1200, writesPerMinute: 300 };

function setup(limits = LIMITS) {
  const redis = new FakeRedis();
  const registry = new Registry();
  let now = START_MS;
  const limiter = new RateLimiter(
    redis as unknown as Redis,
    limits,
    registry,
    () => now,
  );
  const advance = (ms: number) => {
    now += ms;
  };
  const unavailable = async () =>
    (
      await registry
        .getSingleMetric('einvoice_ratelimit_unavailable_total')!
        .get()
    ).values[0]?.value;
  return { redis, limiter, advance, unavailable, registry };
}

describe('RateLimiter', () => {
  it('deja pasar hasta el tope y rechaza la petición siguiente con el reintento correcto', async () => {
    const { limiter } = setup({ requestsPerMinute: 3, writesPerMinute: 300 });
    for (let i = 0; i < 3; i++) {
      expect(await limiter.check('u', false)).toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });
    }
    expect(await limiter.check('u', false)).toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });
  });

  it('rechaza la escritura 301 y no gasta cupo de lectura', async () => {
    const { limiter, redis } = setup();
    for (let i = 0; i < 300; i++) {
      expect((await limiter.check('u', true)).allowed).toBe(true);
    }
    expect(await limiter.check('u', true)).toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });
    const reads = [...redis.counters].find(([k]) => k.includes(':r:'))![1];
    expect(reads).toBe(300);
  });

  it('rechaza la lectura 1201', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 1200; i++) {
      expect((await limiter.check('u', false)).allowed).toBe(true);
    }
    expect((await limiter.check('u', false)).allowed).toBe(false);
  });

  it('pone EXPIRE 120 solo cuando el contador vale 1', async () => {
    const { limiter, redis } = setup();
    await limiter.check('u', false);
    await limiter.check('u', false);
    expect([...redis.expires.values()]).toEqual([120]);
    expect(redis.expires.size).toBe(1);
  });

  it('con Redis caído deja pasar, cuenta y no lo consulta durante 10 s', async () => {
    const { limiter, redis, advance, unavailable } = setup({
      requestsPerMinute: 1,
      writesPerMinute: 1,
    });
    redis.failing = true;
    expect((await limiter.check('u', true)).allowed).toBe(true);
    expect(redis.calls).toBe(1);
    expect(await unavailable()).toBe(1);

    advance(9_999);
    expect((await limiter.check('u', true)).allowed).toBe(true);
    expect((await limiter.check('u', true)).allowed).toBe(true);
    expect(redis.calls).toBe(1);
    expect(await unavailable()).toBe(3);

    advance(1);
    await limiter.check('u', true);
    expect(redis.calls).toBe(2);
    expect(await unavailable()).toBe(4);
  });
});
