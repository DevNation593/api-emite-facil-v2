import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { RabbitConnection } from '../../../src/infrastructure/rabbit.module.js';
import { testConfig } from '../../support/test-env.js';

// Sin mock de amqplib: un servidor que acepta el socket y no contesta el handshake AMQP.
it('un handshake colgado falla en plazo y el siguiente intento vuelve a conectar', async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const rabbit = new RabbitConnection({
    ...testConfig,
    rabbit: { ...testConfig.rabbit, host: '127.0.0.1', port },
  });
  try {
    for (const attempt of [1, 2]) {
      const started = Date.now();
      await expect(rabbit.ensureOpen()).rejects.toThrow(/ETIMEDOUT/);
      expect(Date.now() - started).toBeLessThan(3_500);
      expect(sockets).toHaveLength(attempt);
    }
    expect(rabbit.isOpen()).toBe(false);
  } finally {
    await rabbit.onApplicationShutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}, 15_000);
