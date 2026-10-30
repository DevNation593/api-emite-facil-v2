import {
  checkHealth,
  type HealthCheck,
} from '../../../src/observability/health.js';

const ok = (name: string): HealthCheck => ({
  name,
  timeoutMs: 200,
  run: async () => undefined,
});

describe('checkHealth', () => {
  it('UP si todas las comprobaciones pasan', async () => {
    await expect(checkHealth([ok('db'), ok('redis')])).resolves.toBe('UP');
  });

  it('DOWN si una lanza', async () => {
    const failing: HealthCheck = {
      name: 'redis',
      timeoutMs: 200,
      run: async () => {
        throw new Error('caída');
      },
    };
    await expect(checkHealth([ok('db'), failing])).resolves.toBe('DOWN');
  });

  it('DOWN en menos de plazo + 100 ms si una tarda más que su plazo', async () => {
    const slow: HealthCheck = {
      name: 'rabbit',
      timeoutMs: 300,
      run: () => new Promise(() => undefined),
    };
    const started = Date.now();
    await expect(checkHealth([ok('db'), slow])).resolves.toBe('DOWN');
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('las comprobaciones corren en paralelo', async () => {
    const wait = (name: string): HealthCheck => ({
      name,
      timeoutMs: 1_000,
      run: () => new Promise((resolve) => setTimeout(resolve, 200)),
    });
    const started = Date.now();
    await checkHealth([wait('a'), wait('b'), wait('c')]);
    expect(Date.now() - started).toBeLessThan(450);
  });

  it('un rechazo tardío de una comprobación vencida no queda sin atender', async () => {
    const late: HealthCheck = {
      name: 'redis',
      timeoutMs: 50,
      run: () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('tarde')), 150),
        ),
    };
    await expect(checkHealth([late])).resolves.toBe('DOWN');
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
});
