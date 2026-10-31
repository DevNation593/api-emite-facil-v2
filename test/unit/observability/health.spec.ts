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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('DOWN en cuanto vence el plazo de la que no contesta', async () => {
    vi.useFakeTimers();
    const slow: HealthCheck = {
      name: 'rabbit',
      timeoutMs: 300,
      run: () => new Promise(() => undefined),
    };
    let result: string | undefined;
    void checkHealth([ok('db'), slow]).then((status) => {
      result = status;
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('DOWN');
  });

  it('las comprobaciones corren en paralelo', async () => {
    vi.useFakeTimers();
    const wait = (name: string): HealthCheck => ({
      name,
      timeoutMs: 1_000,
      run: () => new Promise((resolve) => setTimeout(resolve, 200)),
    });
    let result: string | undefined;
    void checkHealth([wait('a'), wait('b'), wait('c')]).then((status) => {
      result = status;
    });
    // En serie harían falta 600 ms.
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toBe('UP');
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
    vi.useFakeTimers();
    let result: string | undefined;
    void checkHealth([late]).then((status) => {
      result = status;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(result).toBe('DOWN');
    await vi.advanceTimersByTimeAsync(150);
  });
});
