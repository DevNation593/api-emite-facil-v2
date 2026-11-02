import {
  type BeforeApplicationShutdown,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

/** Una tarea periódica del worker. */
export interface ScheduledTask {
  name: string;
  /** Espera entre el fin de una pasada y el inicio de la siguiente. */
  intervalMs: number;
  /** Espera hasta la primera pasada; por defecto, un intervalo. */
  initialDelayMs?: number;
  run(): Promise<void>;
}

/** El error en una línea, sin la pila. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  return `${error.name}${typeof code === 'string' ? ` (${code})` : ''}: ${error.message}`;
}

/**
 * Tareas periódicas del worker con la semántica de `@Scheduled(initialDelay, fixedDelay)` de
 * Spring: la espera se cuenta desde que termina la pasada anterior, así que dos pasadas de la
 * misma tarea nunca se solapan. Arranca con la aplicación y, al cerrarla, espera a la pasada en
 * curso antes de que se cierren la base y las demás conexiones (BeforeApplicationShutdown).
 */
export class FixedDelayScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(FixedDelayScheduler.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<Promise<void>>();
  private stopped = true;

  constructor(private readonly tasks: readonly ScheduledTask[]) {}

  taskNames(): string[] {
    return this.tasks.map((task) => task.name);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const task of this.tasks) this.schedule(task, task.initialDelayMs ?? task.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.running);
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  private schedule(task: ScheduledTask, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(task.name);
      const pass = this.runOnce(task);
      this.running.add(pass);
      void pass.finally(() => {
        this.running.delete(pass);
        if (!this.stopped) this.schedule(task, task.intervalMs);
      });
    }, delayMs);
    // El temporizador no mantiene vivo el proceso: lo mantiene el servidor HTTP.
    timer.unref();
    this.timers.set(task.name, timer);
  }

  private async runOnce(task: ScheduledTask): Promise<void> {
    try {
      await task.run();
    } catch (error) {
      // Cada tarea maneja sus fallos; esto solo evita que uno inesperado corte la programación.
      this.logger.error(`La tarea ${task.name} falló: ${describeError(error)}`);
    }
  }
}
