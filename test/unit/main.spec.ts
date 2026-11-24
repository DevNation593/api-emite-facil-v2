import http from 'node:http';
import type { RequestListener } from 'node:http';
import request from 'supertest';

// El lanzador de Vercel importa la entrada con Server.prototype.listen sustituido por una función que no
// escucha ni llama a su callback, y atiende las peticiones con la exportación por defecto. Si main.ts esperase
// a listen(), el import no terminaría y todas las peticiones se quedarían colgadas.
it('main.ts termina de cargarse y exporta su manejador aunque listen() no avise nunca', async () => {
  const signals = ['SIGTERM', 'SIGINT'] as const;
  const before = signals.map((signal) => process.listeners(signal));
  const listen = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server) {
    return this;
  });
  try {
    const { default: handler } = (await import('../../src/main.js')) as unknown as {
      default: RequestListener;
    };

    expect(typeof handler).toBe('function');
    listen.mockRestore();
    await request(handler).get('/actuator/health/liveness').expect(200, { status: 'UP' });
    await request(handler).get('/api/v1/auth/me').expect(401);
  } finally {
    listen.mockRestore();
    for (const [i, signal] of signals.entries()) {
      for (const listener of process.listeners(signal)) {
        if (!before[i]!.includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
}, 15_000);
