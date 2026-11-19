import type { Channel } from 'amqplib';

/*
 * Topología de RabbitMQ, como orchestration/MessagingConfig.java. Los eventos del outbox llegan a la cola de
 * procesamiento de comprobantes; un mensaje que el worker rechaza definitivamente pasa a la cola de mensajes
 * muertos, donde espera a un operador.
 */

export const EVENTS_EXCHANGE = 'fiscal.events';
export const DEAD_LETTER_EXCHANGE = 'fiscal.dlx';

export const ISSUE_QUEUE = 'document.issue';
export const ISSUE_ROUTING_KEY = 'document.issue';
export const DEAD_LETTER_QUEUE = 'document.issue.dlq';

/** Cola de archivo y entrega de comprobantes autorizados. */
export const DELIVER_QUEUE = 'document.deliver';
export const DELIVER_ROUTING_KEY = 'document.deliver';
export const DELIVER_DEAD_LETTER_QUEUE = 'document.deliver.dlq';

/** Cola de avisos a los sistemas de las empresas: aparte, para que un receptor lento no frene lo demás. */
export const WEBHOOK_QUEUE = 'webhook.deliver';
export const WEBHOOK_ROUTING_KEY = 'webhook.deliver';
export const WEBHOOK_DEAD_LETTER_QUEUE = 'webhook.deliver.dlq';

/**
 * Cola a la que va cada tipo de evento del outbox: la autorización y todo lo relativo a la entrega, a la de
 * entrega; los avisos, a la suya; el resto hace avanzar el comprobante ante el SRI.
 */
export function routingKey(eventType: string): string {
  if (eventType.startsWith('WEBHOOK_')) return WEBHOOK_ROUTING_KEY;
  return eventType === 'DOCUMENT_AUTHORIZED' || eventType.startsWith('DELIVERY_') ? DELIVER_ROUTING_KEY : ISSUE_ROUTING_KEY;
}

const WORK_QUEUES: ReadonlyArray<{ queue: string; routingKey: string; deadLetter: string }> = [
  { queue: ISSUE_QUEUE, routingKey: ISSUE_ROUTING_KEY, deadLetter: DEAD_LETTER_QUEUE },
  { queue: DELIVER_QUEUE, routingKey: DELIVER_ROUTING_KEY, deadLetter: DELIVER_DEAD_LETTER_QUEUE },
  { queue: WEBHOOK_QUEUE, routingKey: WEBHOOK_ROUTING_KEY, deadLetter: WEBHOOK_DEAD_LETTER_QUEUE },
];

/** Declara exchanges, colas y enlaces (idempotente: lo ya declarado igual no cambia). */
export async function declareTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true, autoDelete: false });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true, autoDelete: false });
  for (const { queue, routingKey: key, deadLetter } of WORK_QUEUES) {
    await channel.assertQueue(queue, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE, 'x-dead-letter-routing-key': deadLetter },
    });
    await channel.assertQueue(deadLetter, { durable: true });
    await channel.bindQueue(queue, EVENTS_EXCHANGE, key);
    await channel.bindQueue(deadLetter, DEAD_LETTER_EXCHANGE, deadLetter);
  }
}
