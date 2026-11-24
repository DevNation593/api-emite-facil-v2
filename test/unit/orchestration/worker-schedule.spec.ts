import { Logger } from '@nestjs/common';
import type { DueDeliveryScheduler } from '../../../src/delivery/due-delivery-scheduler.js';
import type { DueDocumentScheduler } from '../../../src/orchestration/due-document-scheduler.js';
import type { OutboxRelay } from '../../../src/orchestration/outbox-relay.js';
import { WorkerSchedule } from '../../../src/orchestration/worker-schedule.js';

// De orchestration/WorkerScheduleTest.java, sin los avisos (E6).
function parts() {
  const calls: string[] = [];
  const due = { enqueueDue: async () => calls.push('comprobantes') } as unknown as DueDocumentScheduler;
  const dueDeliveries = { enqueueDue: async () => calls.push('entregas') } as unknown as DueDeliveryScheduler;
  let published = 0;
  const relay = {
    publishPending: async () => {
      calls.push('outbox');
      return published++ === 0 ? 3 : 0;
    },
  } as unknown as OutboxRelay;
  return { calls, due, dueDeliveries, relay };
}

it('encola los comprobantes y las entregas vencidas y publica mientras haya eventos', async () => {
  const { calls, due, dueDeliveries, relay } = parts();

  await new WorkerSchedule(due, dueDeliveries, relay).tick();

  expect(calls).toEqual(['comprobantes', 'entregas', 'outbox', 'outbox']);
});

it('un fallo se registra y espera al siguiente latido', async () => {
  const { calls, due, relay } = parts();
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const broken = {
    enqueueDue: () => Promise.reject(new Error('la base no responde')),
  } as unknown as DueDeliveryScheduler;
  try {
    await expect(new WorkerSchedule(due, broken, relay).tick()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('El latido del worker falló'));
  } finally {
    warn.mockRestore();
  }
  expect(calls).toEqual(['comprobantes']);
});
