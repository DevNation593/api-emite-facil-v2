import { EventEmitter } from 'node:events';
import { connect } from 'amqplib';
import { RabbitConnection } from '../../../src/infrastructure/rabbit.module.js';
import { testConfig } from '../../support/test-env.js';

vi.mock('amqplib', () => ({ connect: vi.fn() }));
const connectMock = vi.mocked(connect);

class FakeModel extends EventEmitter {
  close = vi.fn(async () => {
    this.emit('close');
  });
  createConfirmChannel = vi.fn(async () => ({}));
}

const asModel = (model: FakeModel) =>
  model as unknown as Awaited<ReturnType<typeof connect>>;

afterEach(() => {
  vi.useRealTimers();
  connectMock.mockReset();
});

it('no conecta al crearse y conecta en la primera operación', async () => {
  const rabbit = new RabbitConnection(testConfig);
  expect(connectMock).not.toHaveBeenCalled();
  expect(rabbit.isOpen()).toBe(false);
  connectMock.mockResolvedValue(asModel(new FakeModel()));
  await rabbit.channel();
  expect(rabbit.isOpen()).toBe(true);
  await rabbit.onApplicationShutdown();
});

it('con el broker caído rechaza la operación sin errores sin atender', async () => {
  connectMock.mockRejectedValue(new Error('ECONNREFUSED'));
  const rabbit = new RabbitConnection(testConfig);
  await expect(rabbit.ensureOpen()).rejects.toThrow('ECONNREFUSED');
  expect(rabbit.isOpen()).toBe(false);
});

it('reconecta con espera creciente tras perder la conexión', async () => {
  vi.useFakeTimers();
  const first = new FakeModel();
  connectMock.mockResolvedValueOnce(asModel(first));
  const rabbit = new RabbitConnection(testConfig);
  await rabbit.ensureOpen();

  connectMock.mockRejectedValueOnce(new Error('caído'));
  const second = new FakeModel();
  connectMock.mockResolvedValueOnce(asModel(second));
  first.emit('error', new Error('socket roto'));
  first.emit('close');
  expect(rabbit.isOpen()).toBe(false);

  await vi.advanceTimersByTimeAsync(999);
  expect(connectMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); // 1 s: primer intento, falla
  expect(connectMock).toHaveBeenCalledTimes(2);
  expect(rabbit.isOpen()).toBe(false);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(connectMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); // 2 s después: segundo intento, conecta
  expect(connectMock).toHaveBeenCalledTimes(3);
  expect(rabbit.isOpen()).toBe(true);
  await rabbit.onApplicationShutdown();
});

it('al apagar cierra la conexión y deja de reconectar', async () => {
  const model = new FakeModel();
  connectMock.mockResolvedValue(asModel(model));
  const rabbit = new RabbitConnection(testConfig);
  await rabbit.ensureOpen();
  await rabbit.onApplicationShutdown();
  expect(model.close).toHaveBeenCalled();
  expect(rabbit.isOpen()).toBe(false);
  await expect(rabbit.ensureOpen()).rejects.toThrow();
});
