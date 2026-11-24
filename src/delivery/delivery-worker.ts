import type { RabbitConnection } from '../infrastructure/rabbit.module.js';
import type { DocumentEvent } from '../orchestration/document-event.js';
import { DELIVER_QUEUE } from '../orchestration/messaging.js';
import { QueueConsumer } from '../orchestration/queue-consumer.js';
import type { DeliveryService } from './delivery.service.js';

/**
 * Consume la cola de entrega: archiva el comprobante autorizado y envía sus entregas pendientes, como
 * delivery/DeliveryWorker.java. Recibir dos veces el mismo evento es inocuo: cada entrega se reserva antes de
 * enviarse. Solo existe en modo worker.
 */
export class DeliveryWorker extends QueueConsumer {
  constructor(
    rabbit: RabbitConnection,
    private readonly deliveries: DeliveryService,
    prefetch: number,
    retryDelaysMs?: readonly number[],
  ) {
    super(DeliveryWorker.name, rabbit, DELIVER_QUEUE, prefetch, retryDelaysMs);
  }

  protected async process(event: DocumentEvent): Promise<string> {
    const sent = await this.deliveries.process(event.tenantId, event.documentId);
    return `Documento ${event.documentId}: ${sent} correo(s) enviado(s) tras el evento ${event.eventType}`;
  }
}
