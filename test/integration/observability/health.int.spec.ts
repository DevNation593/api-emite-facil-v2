import net from 'node:net';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../../../src/bootstrap.js';
import { readiness } from '../../../src/observability/lifecycle.js';
import { startStack, type StackHandle } from '../../support/containers.js';

const UP = { status: 'UP', groups: ['liveness', 'readiness'] };
const DOWN = { status: 'DOWN', groups: ['liveness', 'readiness'] };

let stack: StackHandle;
const saved = { ...process.env };
const apps: NestExpressApplication[] = [];

async function appWith(env: Record<string, string>): Promise<NestExpressApplication> {
  Object.assign(process.env, env);
  const app = await createApp();
  await app.init();
  apps.push(app);
  return app;
}

beforeAll(async () => {
  stack = await startStack();
}, 300_000);

afterAll(async () => {
  await Promise.allSettled(apps.map((app) => app.close()));
  await stack?.stop();
  process.env = saved;
});

it('UP con la pila real y DOWN al parar Redis, sin colgarse', async () => {
  const app = await appWith({
    DATABASE_URL: stack.databaseUrl,
    RABBITMQ_URL: stack.rabbitUrl,
    REDIS_URL: stack.redisUrl,
  });
  const http = request(app.getHttpServer());
  const res = await http.get('/actuator/health').expect(200, UP);
  expect(res.headers['content-type']).toBe('application/vnd.spring-boot.actuator.v3+json');

  await stack.containers.redis.stop();
  const started = Date.now();
  await http.get('/actuator/health').expect(503, DOWN);
  expect(Date.now() - started).toBeLessThan(2_500);
  await http.get('/actuator/health/liveness').expect(200, { status: 'UP' });
});

it('Redis colgado (acepta y no contesta) no cuelga el health', async () => {
  const sockets = new Set<net.Socket>();
  const hung = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = hung.address() as net.AddressInfo;
    const app = await appWith({
      DATABASE_URL: stack.databaseUrl,
      RABBITMQ_URL: stack.rabbitUrl,
      REDIS_URL: `redis://127.0.0.1:${port}`,
      REDIS_TIMEOUT: '500ms',
    });
    const started = Date.now();
    await request(app.getHttpServer()).get('/actuator/health').expect(503, DOWN);
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    for (const socket of sockets) socket.destroy();
    hung.close();
  }
});

it('sin infraestructura la aplicación arranca y el health da DOWN sin colgarse', async () => {
  // Nada escucha en el puerto 1: la conexión se rechaza al instante.
  const app = await appWith({
    DATABASE_URL: 'postgresql://app:app@127.0.0.1:1/einvoice',
    RABBITMQ_URL: 'amqp://guest:guest@127.0.0.1:1',
    REDIS_URL: 'redis://127.0.0.1:1',
  });
  const started = Date.now();
  await request(app.getHttpServer()).get('/actuator/health').expect(503, DOWN);
  expect(Date.now() - started).toBeLessThan(2_500);
});

it('readiness refleja el estado de ciclo de vida', async () => {
  const app = await appWith({});
  const http = request(app.getHttpServer());
  readiness.markReady();
  await http.get('/actuator/health/readiness').expect(200, { status: 'UP' });
  readiness.markOutOfService();
  await http.get('/actuator/health/readiness').expect(503, { status: 'OUT_OF_SERVICE' });
});

it('las rutas de actuator no llevan el prefijo /api/v1', async () => {
  const app = await appWith({});
  await request(app.getHttpServer()).get('/api/v1/actuator/health').expect(404);
});
