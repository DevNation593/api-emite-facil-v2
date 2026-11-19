import {
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_QUEUE,
  DELIVER_DEAD_LETTER_QUEUE,
  DELIVER_QUEUE,
  DELIVER_ROUTING_KEY,
  EVENTS_EXCHANGE,
  ISSUE_QUEUE,
  ISSUE_ROUTING_KEY,
  routingKey,
  WEBHOOK_DEAD_LETTER_QUEUE,
  WEBHOOK_QUEUE,
  WEBHOOK_ROUTING_KEY,
} from '../../../src/orchestration/messaging.js';

// Traducción de orchestration/MessagingConfigTest.java más los nombres de MessagingConfig.
it('legacyAndNewReservedEventsGoToIssue', () => {
  expect(routingKey('DOCUMENT_RESERVED')).toBe(ISSUE_ROUTING_KEY);
  expect(routingKey('INVOICE_RESERVED')).toBe(ISSUE_ROUTING_KEY);
});

it('cada tipo de evento va a su cola', () => {
  expect(routingKey('DOCUMENT_DUE')).toBe(ISSUE_ROUTING_KEY);
  expect(routingKey('DOCUMENT_RETRY_REQUESTED')).toBe(ISSUE_ROUTING_KEY);
  expect(routingKey('DOCUMENT_AUTHORIZED')).toBe(DELIVER_ROUTING_KEY);
  expect(routingKey('DELIVERY_DUE')).toBe(DELIVER_ROUTING_KEY);
  expect(routingKey('WEBHOOK_DUE')).toBe(WEBHOOK_ROUTING_KEY);
});

it('los nombres son los de Java', () => {
  expect([EVENTS_EXCHANGE, DEAD_LETTER_EXCHANGE]).toEqual(['fiscal.events', 'fiscal.dlx']);
  expect([ISSUE_QUEUE, DELIVER_QUEUE, WEBHOOK_QUEUE]).toEqual(['document.issue', 'document.deliver', 'webhook.deliver']);
  expect([DEAD_LETTER_QUEUE, DELIVER_DEAD_LETTER_QUEUE, WEBHOOK_DEAD_LETTER_QUEUE]).toEqual([
    'document.issue.dlq',
    'document.deliver.dlq',
    'webhook.deliver.dlq',
  ]);
});
