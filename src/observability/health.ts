export type HealthStatus = 'UP' | 'DOWN';

export interface HealthCheck {
  name: string;
  /** Plazo propio de la comprobación: pasado ese tiempo cuenta como caída. */
  timeoutMs: number;
  run(): Promise<void>;
}

/** Rechaza si `run` no termina en `timeoutMs`; el temporizador no mantiene vivo el proceso. */
function withDeadline(check: HealthCheck): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${check.name}: sin respuesta en ${check.timeoutMs} ms`)),
      check.timeoutMs,
    );
    timer.unref();
    // Si la comprobación vencida falla más tarde, el rechazo ya está atendido aquí.
    check.run().then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Ejecuta todas las comprobaciones en paralelo; la respuesta tarda, como mucho, lo que la
 * más lenta de los plazos. Cualquier fallo o plazo vencido da DOWN.
 */
export async function checkHealth(checks: HealthCheck[]): Promise<HealthStatus> {
  const results = await Promise.allSettled(checks.map(withDeadline));
  return results.every((result) => result.status === 'fulfilled') ? 'UP' : 'DOWN';
}
