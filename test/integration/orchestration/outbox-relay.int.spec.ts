import { execFileSync } from 'node:child_process';
import type { Kysely } from 'kysely';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import pg from 'pg';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { RabbitConnection } from '../../../src/infrastructure/rabbit.module.js';
import { DEAD_LETTER_QUEUE, declareTopology, ISSUE_QUEUE } from '../../../src/orchestration/messaging.js';
import { OutboxRelay } from '../../../src/orchestration/outbox-relay.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { billingScenario, invoiceJson, issueInvoice, type BillingScenario } from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de orchestration/OutboxRelayIT.java más el Review Focus: RabbitMQ caído mientras se publica, un
// error del canal y dos relays a la vez. El worker está apagado: nadie consume la cola.
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let kysely: Kysely<DB>;
let rabbit: RabbitConnection;
let relay: OutboxRelay;
let amqp: ChannelModel;
let probe: Channel;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack, { EINVOICE_WORKER_ENABLED: 'false' });
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  kysely = testApp.app.get(DATABASE);
  rabbit = testApp.app.get(RabbitConnection);
  relay = new OutboxRelay(kysely, rabbit, 2_000);
  amqp = await connect(stack.rabbitUrl);
  probe = await amqp.createChannel();
  await declareTopology(probe);
}, 300_000);
afterAll(async () => {
  await amqp?.close().catch(() => undefined);
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});

let s: BillingScenario;
let document: string;
beforeEach(async () => {
  await drain(ISSUE_QUEUE);
  await drain(DEAD_LETTER_QUEUE);
  s = await billingScenario(testApp.http, db);
  document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'));
});

type Body = Record<string, string>;

async function drain(queue: string): Promise<Body[]> {
  const bodies: Body[] = [];
  for (;;) {
    const message = await probe.get(queue, { noAck: true });
    if (message === false) return bodies;
    try {
      bodies.push(JSON.parse(message.content.toString('utf8')) as Body);
    } catch {
      bodies.push({ raw: message.content.toString('utf8') });
    }
  }
}

async function publishEverything(): Promise<void> {
  // Otras pruebas dejaron eventos pendientes: se publican todos.
  while ((await relay.publishPending()) > 0);
}

const mineIn = (bodies: Body[]) => bodies.filter((b) => b.documentId === document);
const dispatched = async () =>
  (await db.query('SELECT dispatched_at IS NOT NULL AS d FROM outbox_events WHERE aggregate_id = $1', [document]))
    .rows[0].d as boolean;

it('pendingEventsArePublishedOnceAndMarked', async () => {
  await publishEverything();

  const mine = mineIn(await drain(ISSUE_QUEUE));
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ tenantId: s.tenant, eventType: 'DOCUMENT_RESERVED' });
  const eventId = (await db.query('SELECT id::text AS id FROM outbox_events WHERE aggregate_id = $1', [document]))
    .rows[0].id as string;
  expect(mine[0]!.eventId).toBe(eventId);
  expect(await dispatched()).toBe(true);

  expect(await relay.publishPending()).toBe(0);
  expect(await drain(ISSUE_QUEUE)).toEqual([]);
});

it('messageCarriesOnlyIdentifiers', async () => {
  await publishEverything();
  const message = await (async () => {
    for (;;) {
      const got = await probe.get(ISSUE_QUEUE, { noAck: true });
      if (got === false) throw new Error('No llegó el mensaje');
      if ((JSON.parse(got.content.toString()) as Body).documentId === document) return got;
    }
  })();
  const body = message.content.toString('utf8');
  // Los cuatro identificadores, en este orden, y nada más.
  expect(Object.keys(JSON.parse(body) as Body)).toEqual(['eventId', 'tenantId', 'documentId', 'eventType']);
  expect(message.properties).toMatchObject({
    contentType: 'application/json',
    messageId: (JSON.parse(body) as Body).eventId,
    deliveryMode: 2,
  });
});

it('rejectedMessageGoesToTheDeadLetterQueue', async () => {
  await publishEverything();

  let rejected = 0;
  for (;;) {
    const delivery = await probe.get(ISSUE_QUEUE, { noAck: false });
    if (delivery === false) break;
    probe.reject(delivery, false);
    rejected++;
  }

  expect(rejected).toBeGreaterThanOrEqual(1);
  const dead = await drain(DEAD_LETTER_QUEUE);
  expect(dead).toHaveLength(rejected);
  expect(mineIn(dead)).toHaveLength(1);
  expect(await drain(ISSUE_QUEUE)).toEqual([]);
});

it('con RabbitMQ detenido, publishPending falla sin marcar nada y al volver publica una vez', async () => {
  await publishEverything();
  await drain(ISSUE_QUEUE);
  const later = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'));
  const id = stack.containers.rabbit.getId();
  execFileSync('docker', ['pause', id]);
  try {
    await expect(relay.publishPending()).rejects.toThrow();
    const pending = await db.query('SELECT dispatched_at FROM outbox_events WHERE aggregate_id = $1', [later]);
    expect(pending.rows).toEqual([{ dispatched_at: null }]);
  } finally {
    execFileSync('docker', ['unpause', id]);
  }

  await vi.waitFor(
    async () => {
      expect(await relay.publishPending()).toBeGreaterThanOrEqual(0);
      const row = await db.query('SELECT dispatched_at FROM outbox_events WHERE aggregate_id = $1', [later]);
      expect(row.rows[0].dispatched_at).not.toBeNull();
    },
    { timeout: 30_000, interval: 500 },
  );
  await publishEverything();
  const delivered = (await drain(ISSUE_QUEUE)).filter((b) => b.documentId === later);
  expect(delivered).toHaveLength(1);
}, 90_000);

it('un error del canal no tumba el proceso', async () => {
  const uncaught = vi.fn();
  const unhandled = vi.fn();
  process.on('uncaughtException', uncaught);
  process.on('unhandledRejection', unhandled);
  try {
    const channel = await rabbit.channel();
    const closed = new Promise<void>((resolve) => channel.once('close', () => resolve()));
    // Publicar en un exchange que no existe hace que el broker cierre el canal con un error.
    channel.publish('no-existe-este-exchange', 'x', Buffer.from('{}'));
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 200));
    // El siguiente uso abre otro canal y publica.
    await publishEverything();
    expect(mineIn(await drain(ISSUE_QUEUE))).toHaveLength(1);
  } finally {
    process.off('uncaughtException', uncaught);
    process.off('unhandledRejection', unhandled);
  }
  expect(uncaught).not.toHaveBeenCalled();
  expect(unhandled).not.toHaveBeenCalled();
});

it('dos relays a la vez no publican el mismo evento dos veces', async () => {
  await publishEverything();
  await drain(ISSUE_QUEUE);
  const issued = await Promise.all(
    Array.from({ length: 6 }, () => issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'))),
  );
  const other = new OutboxRelay(kysely, rabbit, 2_000);

  await Promise.all([publishEverything(), (async () => {
    while ((await other.publishPending()) > 0);
  })()]);

  const bodies = (await drain(ISSUE_QUEUE)).filter((b) => issued.includes(b.documentId!));
  expect(bodies).toHaveLength(issued.length);
  expect(new Set(bodies.map((b) => b.eventId)).size).toBe(issued.length);
});
