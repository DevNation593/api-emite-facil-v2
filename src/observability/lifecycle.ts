import type { Server } from 'node:http';
import net from 'node:net';
import { Logger, type INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export type ReadinessState = 'UP' | 'OUT_OF_SERVICE';

let state: ReadinessState = 'OUT_OF_SERVICE';

/**
 * Estado de readiness del proceso. Empieza fuera de servicio (como Spring antes de
 * ApplicationReadyEvent): main.ts lo marca listo tras escuchar y lo baja al recibir SIGTERM.
 */
export const readiness = {
  markReady(): void {
    state = 'UP';
  },
  markOutOfService(): void {
    state = 'OUT_OF_SERVICE';
  },
  state(): ReadinessState {
    return state;
  },
};

let inFlight = 0;

/** Cuenta las peticiones en curso para saber cuándo se ha vaciado el servidor. */
export function inFlightMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  inFlight++;
  // 'close' se emite siempre al terminar la respuesta, incluso si el cliente se va antes.
  res.once('close', () => {
    inFlight--;
  });
  next();
}

const POLL_MS = 25;
const CLOSE_GRACE_MS = 2_000;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Cierre ordenado, como el graceful shutdown de Spring: readiness pasa a OUT_OF_SERVICE, el
 * servidor deja de aceptar conexiones nuevas, se espera a las peticiones en curso (hasta
 * `timeoutMs`; las conexiones que ya existían siguen respondiendo mientras tanto) y por último
 * app.close() cierra pool, Redis y RabbitMQ (cada uno con su propio plazo).
 */
export async function gracefulShutdown(
  app: INestApplication,
  timeoutMs = 8_000,
): Promise<void> {
  readiness.markOutOfService();
  const server = app.getHttpServer() as Server;
  if (server.listening) {
    // Server.close() de http cerraría ya las conexiones ociosas: se usa el cierre de net,
    // que solo deja de escuchar, y se despejan las ociosas cuando no quede nada en curso.
    const closed = new Promise<void>((resolve) => {
      net.Server.prototype.close.call(server, () => resolve());
    });
    const deadline = Date.now() + timeoutMs;
    while (inFlight > 0 && Date.now() < deadline) await sleep(POLL_MS);
    server.closeIdleConnections();
    // Lo que no haya terminado a tiempo se corta, para que el cierre nunca se cuelgue.
    const timer = setTimeout(
      () => server.closeAllConnections(),
      Math.max(0, deadline - Date.now()),
    );
    timer.unref();
    await closed;
    clearTimeout(timer);
  }
  await closeBounded(app);
}

/**
 * app.close() cierra pool, Redis y RabbitMQ; si alguno se cuelga (p. ej. una base que no
 * responde), se avisa y se sigue para que main.ts pueda salir.
 */
async function closeBounded(app: INestApplication): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), CLOSE_GRACE_MS);
  });
  try {
    const result = await Promise.race([
      app.close().then(() => 'closed' as const),
      expired,
    ]);
    if (result === 'expired') {
      new Logger('Lifecycle').warn(
        `El cierre de conexiones no terminó en ${CLOSE_GRACE_MS} ms; se continúa`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
