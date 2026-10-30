import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../../../src/bootstrap.js';
import { gracefulShutdown, readiness } from '../../../src/observability/lifecycle.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { SlowModule } from '../../support/slow.module.js';

function get(port: number, path: string, agent?: http.Agent) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, agent }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

it('gracefulShutdown deja terminar la petición en curso y pone readiness en OUT_OF_SERVICE', async () => {
  const app = await createApp({ imports: [SlowModule] });
  const port = await freePort();
  await app.listen(port, '127.0.0.1');
  readiness.markReady();

  // Conexión abierta antes del cierre, con una petición ya servida.
  const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 1 });
  expect((await get(port, '/actuator/health/readiness', keepAlive)).status).toBe(200);

  const slow = get(port, '/api/v1/test/slow');
  await sleep(100);
  const started = Date.now();
  const shutdown = gracefulShutdown(app);
  await sleep(100);

  const during = await get(port, '/actuator/health/readiness', keepAlive);
  expect(during.status).toBe(503);
  expect(JSON.parse(during.body)).toEqual({ status: 'OUT_OF_SERVICE' });
  await expect(get(port, '/actuator/health/liveness')).rejects.toMatchObject({
    code: 'ECONNREFUSED',
  });

  const done = await slow;
  expect(done.status).toBe(200);
  await shutdown;
  expect(Date.now() - started).toBeLessThan(5_000);
  keepAlive.destroy();
});

describe('proceso real', () => {
  let stack: StackHandle;
  beforeAll(async () => {
    stack = await startStack();
  }, 300_000);
  afterAll(async () => {
    await stack?.stop();
  });

  it.skipIf(process.platform === 'win32')(
    'node dist/main.js sale con código 0 en menos de 10 s tras SIGTERM',
    async () => {
      const port = await freePort();
      const child = spawn('node', ['dist/main.js'], {
        env: {
          ...process.env,
          DATABASE_URL: stack.databaseUrl,
          RABBITMQ_URL: stack.rabbitUrl,
          REDIS_URL: stack.redisUrl,
          SERVER_PORT: String(port),
        },
        stdio: 'ignore',
      });
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      const deadline = Date.now() + 30_000;
      for (;;) {
        const ready = await get(port, '/actuator/health/readiness').catch(() => undefined);
        if (ready?.status === 200) break;
        if (Date.now() > deadline) {
          child.kill('SIGKILL');
          throw new Error('La aplicación no llegó a estar lista');
        }
        await sleep(200);
      }
      const started = Date.now();
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(Date.now() - started).toBeLessThan(10_000);
    },
    60_000,
  );
});
