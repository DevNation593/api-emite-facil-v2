import { createApp } from '../../../src/bootstrap.js';
import { AuthPurge } from '../../../src/identity/auth-purge.js';
import {
  FixedDelayScheduler,
  type ScheduledTask,
} from '../../../src/orchestration/fixed-delay-scheduler.js';

/** Crea la aplicación con EINVOICE_WORKER_ENABLED fijado solo mientras arranca. */
async function appWithWorker(enabled: string | undefined) {
  const previous = process.env.EINVOICE_WORKER_ENABLED;
  if (enabled === undefined) delete process.env.EINVOICE_WORKER_ENABLED;
  else process.env.EINVOICE_WORKER_ENABLED = enabled;
  try {
    return await createApp();
  } finally {
    if (previous === undefined) delete process.env.EINVOICE_WORKER_ENABLED;
    else process.env.EINVOICE_WORKER_ENABLED = previous;
  }
}

describe('WorkerModule en la aplicación', () => {
  it('con el worker apagado la purga no existe', async () => {
    const app = await appWithWorker('false');
    expect(() => app.get(AuthPurge, { strict: false })).toThrow();
    expect(() => app.get(FixedDelayScheduler, { strict: false })).toThrow();
    await app.close();
  });

  it('por defecto el worker está encendido y programa la purga', async () => {
    const app = await appWithWorker(undefined);
    expect(app.get(AuthPurge, { strict: false })).toBeInstanceOf(AuthPurge);
    expect(app.get(FixedDelayScheduler, { strict: false }).taskNames()).toEqual(['auth-purge']);
    // Arrancar y cerrar no necesita la base: la primera pasada es dentro de una hora.
    await app.init();
    await app.close();
  });
});

describe('FixedDelayScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function task(run: () => Promise<void>, intervalMs = 1_000): ScheduledTask {
    return { name: 'prueba', intervalMs, run };
  }

  it('la primera pasada espera un intervalo completo, como initialDelay', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new FixedDelayScheduler([task(run)]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('la espera se cuenta desde que termina la pasada anterior, como fixedDelay', async () => {
    const starts: number[] = [];
    const run = vi.fn(async () => {
      starts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    const start = Date.now();
    const scheduler = new FixedDelayScheduler([task(run)]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(4_000);
    // 1000 de espera + 500 de pasada + 1000 de espera...: empieza en 1000, 2500 y 4000.
    expect(starts.map((t) => t - start)).toEqual([1_000, 2_500, 4_000]);
    // La tercera pasada sigue en curso: stop la espera, así que el reloj tiene que avanzar.
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopping;
  });

  it('una pasada que falla no detiene las siguientes', async () => {
    const run = vi.fn(async () => {
      throw new Error('base caída');
    });
    const scheduler = new FixedDelayScheduler([task(run)]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(3);
    await scheduler.stop();
  });

  it('stop espera la pasada en curso y no programa otra', async () => {
    let finished = false;
    const run = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      finished = true;
    });
    const scheduler = new FixedDelayScheduler([task(run)]);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_100);
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopping;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop antes de la primera pasada no la ejecuta', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new FixedDelayScheduler([task(run)]);
    scheduler.start();
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
  });
});
