import { Logger } from '@nestjs/common';
import type { DueDeliveryScheduler } from '../delivery/due-delivery-scheduler.js';
import type { DueDocumentScheduler } from './due-document-scheduler.js';
import { describeError } from './fixed-delay-scheduler.js';
import type { OutboxRelay } from './outbox-relay.js';

/*
 * Latido del worker, como orchestration/WorkerSchedule.java: encola los comprobantes y las
 * entregas vencidos y publica el outbox. Los atrasados de avisos (E6) se añadirán aquí, con su propio try.
 */

/** Tope de lotes por latido, para que una avalancha de eventos no acapare el planificador. */
const MAX_BATCHES_PER_TICK = 20;

export const WORKER_TICK = 'worker-tick';

export class WorkerSchedule {
  private readonly logger = new Logger(WorkerSchedule.name);

  constructor(
    private readonly due: DueDocumentScheduler,
    private readonly dueDeliveries: DueDeliveryScheduler,
    private readonly relay: OutboxRelay,
  ) {}

  async tick(): Promise<void> {
    try {
      await this.due.enqueueDue();
      await this.dueDeliveries.enqueueDue();
      let batches = 0;
      // Sigue mientras queden eventos por publicar.
      while ((await this.relay.publishPending()) > 0 && ++batches < MAX_BATCHES_PER_TICK);
    } catch (error) {
      // Base o broker no disponibles: nada se pierde, el siguiente latido lo vuelve a intentar.
      this.logger.warn(`El latido del worker falló: ${describeError(error)}`);
    }
  }
}
