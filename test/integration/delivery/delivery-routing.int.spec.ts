import { randomUUID } from 'node:crypto';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import pg from 'pg';
import {
  DEAD_LETTER_QUEUE,
  declareTopology,
  DELIVER_DEAD_LETTER_QUEUE,
  DELIVER_QUEUE,
  ISSUE_QUEUE,
} from '../../../src/orchestration/messaging.js';
import { OutboxRelay } from '../../../src/orchestration/outbox-relay.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { newOwner } from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de delivery/DeliveryRoutingIT.java: cada tipo de evento del outbox va a su cola. Con el worker apagado
// nadie consume.
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let amqp: ChannelModel;
let channel: Channel;
let relay: OutboxRelay;
let tenant: string;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  amqp = await connect(stack.rabbitUrl);
  channel = await amqp.createChannel();
  await declareTopology(channel);
  relay = testApp.app.get(OutboxRelay);
}, 300_000);
afterAll(async () => {
  await amqp?.close().catch(() => undefined);
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});

async function publishAll(): Promise<void> {
  while ((await relay.publishPending()) > 0);
}

/** Vacía la cola y devuelve los documentos de los mensajes que tenía. */
async function drain(queue: string): Promise<string[]> {
  const documents: string[] = [];
  for (let empty = 0; empty < 3; ) {
    const message = await channel.get(queue, { noAck: true });
    if (message === false) {
      empty++;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } else {
      documents.push((JSON.parse(message.content.toString('utf8')) as { documentId: string }).documentId);
    }
  }
  return documents;
}

beforeEach(async () => {
  tenant = (await newOwner(testApp.http)).tenant;
  await publishAll();
  for (const queue of [ISSUE_QUEUE, DELIVER_QUEUE, DEAD_LETTER_QUEUE, DELIVER_DEAD_LETTER_QUEUE]) {
    await channel.purgeQueue(queue);
  }
});

async function event(type: string): Promise<string> {
  const aggregate = randomUUID();
  await db.query("INSERT INTO outbox_events (tenant_id, aggregate_id, event_type, payload) VALUES ($1, $2, $3, '{}')", [
    tenant,
    aggregate,
    type,
  ]);
  return aggregate;
}

it('eventsAreRoutedByType', async () => {
  const deliver = [await event('DOCUMENT_AUTHORIZED'), await event('DELIVERY_DUE'), await event('DELIVERY_REQUESTED')];
  const issue = [
    await event('INVOICE_RESERVED'),
    await event('DOCUMENT_DUE'),
    await event('DOCUMENT_RETRY_REQUESTED'),
  ];

  await publishAll();

  expect((await drain(DELIVER_QUEUE)).sort()).toEqual(deliver.sort());
  expect((await drain(ISSUE_QUEUE)).sort()).toEqual(issue.sort());
});

it('rejectedDeliveryMessageGoesToItsDeadLetterQueue', async () => {
  const authorized = await event('DOCUMENT_AUTHORIZED');
  await publishAll();

  const message = await vi.waitFor(async () => {
    const got = await channel.get(DELIVER_QUEUE);
    if (got === false) throw new Error('aún no llegó');
    return got;
  });
  channel.reject(message, false);

  expect(await drain(DELIVER_DEAD_LETTER_QUEUE)).toEqual([authorized]);
  expect(await drain(DEAD_LETTER_QUEUE)).toEqual([]);
  expect(await drain(DELIVER_QUEUE)).toEqual([]);
});
