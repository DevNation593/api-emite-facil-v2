import type { RabbitConnection } from '../infrastructure/rabbit.module.js';
import type { DocumentEvent } from './document-event.js';
import type { DocumentPipeline } from './document-pipeline.js';
import { ISSUE_QUEUE } from './messaging.js';
import { QueueConsumer } from './queue-consumer.js';

/**
 * Consume la cola de comprobantes y hace avanzar cada documento, como orchestration/DocumentWorker.java. Recibir
 * dos veces el mismo evento es inocuo: el pipeline decide qué hacer según el estado en que encuentre el documento.
 * Solo existe en modo worker.
 */
export class DocumentWorker extends QueueConsumer {
  constructor(
    rabbit: RabbitConnection,
    private readonly pipeline: DocumentPipeline,
    prefetch: number,
    retryDelaysMs?: readonly number[],
  ) {
    super(DocumentWorker.name, rabbit, ISSUE_QUEUE, prefetch, retryDelaysMs);
  }

  protected async process(event: DocumentEvent): Promise<string> {
    const state = await this.pipeline.advance(event.tenantId, event.documentId);
    return `Documento ${event.documentId} en estado ${state} tras el evento ${event.eventType}`;
  }
}
