import { randomUUID } from 'node:crypto';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import pg from 'pg';
import { DeliveryWorker } from '../../../src/delivery/delivery-worker.js';
import { DocumentWorker } from '../../../src/orchestration/document-worker.js';
import {
  DEAD_LETTER_QUEUE,
  declareTopology,
  DELIVER_DEAD_LETTER_QUEUE,
  DELIVER_ROUTING_KEY,
  EVENTS_EXCHANGE,
  ISSUE_ROUTING_KEY,
} from '../../../src/orchestration/messaging.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { deliveryTestEnv } from '../../support/delivery-scenario.js';
import { ScriptedSmtp, SmtpReply } from '../../support/scripted-smtp.js';
import {
  accessKeyOf,
  bearer,
  billingScenario,
  invoiceJson,
  issueInvoice,
  uploadTestCertificate,
} from '../../support/scenario.js';
import { authorized, processing } from '../../support/sri-soap-samples.js';
import { Reply, SriStub, sriTestEnv } from '../../support/sri-stub.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// De orchestration/PipelineEndToEndIT.java: el recorrido completo con el worker encendido (outbox, RabbitMQ,
// generación, firma, recepción, autorización, archivo y correo) sin ninguna llamada manual al pipeline. Las de webhooks y
// llegan en E6.
const PATIENCE_MS = 40_000;
let stack: StackHandle;
let sri: SriStub;
let smtp: ScriptedSmtp;
let testApp: TestApp;
let db: pg.Client;
let amqp: ChannelModel;
let probe: Channel;

beforeAll(async () => {
  stack = await startStack();
  sri = await SriStub.start();
  smtp = await ScriptedSmtp.start();
  testApp = await startTestApp(stack, {
    ...sriTestEnv(sri),
    ...deliveryTestEnv(smtp),
    EINVOICE_WORKER_ENABLED: 'true',
    EINVOICE_WORKER_POLL_INTERVAL_MS: '200',
  });
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  amqp = await connect(stack.rabbitUrl);
  probe = await amqp.createChannel();
  await declareTopology(probe);
}, 300_000);
afterAll(async () => {
  await amqp?.close().catch(() => undefined);
  await db?.end();
  await testApp?.close();
  await smtp?.close();
  await sri?.close();
  await stack?.stop();
});

const stateByApi = async (token: string, document: string) =>
  (
    (await testApp.http.get(`/api/v1/documents/${document}`).set('Authorization', bearer(token))).body as {
      state: string;
    }
  ).state;

async function awaitState(token: string, document: string, state: string): Promise<void> {
  await vi.waitFor(async () => expect(await stateByApi(token, document)).toBe(state), {
    timeout: PATIENCE_MS,
    interval: 200,
  });
}

async function receive(queue: string, timeoutMs: number): Promise<Buffer | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const message = await probe.get(queue, { noAck: true });
    if (message !== false) return message.content;
    if (Date.now() > until) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

it('issuedInvoiceEndsAuthorizedWithoutAnyManualStep', async () => {
  const s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);

  const document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));

  await awaitState(s.owner, document, 'AUTHORIZED');
  const key = await accessKeyOf(db, document);
  expect(sri.receptionCalls(key)).toBe(1);
  expect((await db.query('SELECT authorization_number FROM fiscal_documents WHERE id = $1', [document])).rows[0]).toEqual(
    { authorization_number: key },
  );
}, 60_000);

it('processingInvoiceIsAuthorizedOnALaterPoll', async () => {
  // Sin certificado el worker deja la factura en SIGNATURE_FAILED: da tiempo a preparar el guion del SRI.
  const s = await billingScenario(testApp.http, db);
  const document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));
  await awaitState(s.owner, document, 'SIGNATURE_FAILED');
  const key = await accessKeyOf(db, document);
  sri.onAuthorization(key, Reply.xml(processing(key)), Reply.xml(processing(key)), Reply.xml(authorized(key)));
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);

  // El planificador la retoma al vencer el intento programado, y vuelve a consultar hasta la autorización.
  await db.query('UPDATE fiscal_documents SET next_attempt_at = now() WHERE id = $1', [document]);

  await awaitState(s.owner, document, 'AUTHORIZED');
  expect(sri.receptionCalls(key)).toBe(1);
  expect(sri.authorizationCalls(key)).toBe(3);
}, 60_000);

it('poisonMessageEndsInTheDeadLetterQueue', async () => {
  probe.publish(EVENTS_EXCHANGE, ISSUE_ROUTING_KEY, Buffer.from('esto no es un evento', 'utf8'));

  const dead = await receive(DEAD_LETTER_QUEUE, PATIENCE_MS);

  expect(dead?.toString('utf8')).toBe('esto no es un evento');

  // El worker sigue atendiendo.
  const s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  const document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'));
  await awaitState(s.owner, document, 'AUTHORIZED');
}, 90_000);

/** Empresa con certificado y un cliente con un correo propio de la prueba. */
async function scenarioWithEmail() {
  const s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  const email = `c-${randomUUID()}@cliente.test`;
  await db.query('UPDATE customers SET email = $1 WHERE id = $2', [email, s.customer]);
  return { s, email };
}

const awaitMail = (email: string) =>
  vi.waitFor(() => expect(smtp.raw(email)).toHaveLength(1), { timeout: PATIENCE_MS, interval: 200 });

it('issuedInvoiceIsEmailedWithoutAnyManualStep', async () => {
  const { s, email } = await scenarioWithEmail();

  const document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));

  await awaitMail(email);
  const message = (await smtp.messages(email))[0]!;
  expect(message.subject).toMatch(/^Factura 001-001-/);
  expect(message.attachments).toHaveLength(2);
  for (const kind of ['ride', 'xml-authorized']) {
    const res = await testApp.http
      .get(`/api/v1/documents/${document}/artifacts/${kind}`)
      .set('Authorization', bearer(s.owner));
    expect(res.status).toBe(200);
  }
  expect(await stateByApi(s.owner, document)).toBe('AUTHORIZED');
  // Archivado y entregado: no queda nada programado para ese comprobante.
  await vi.waitFor(
    async () =>
      expect((await db.query('SELECT next_attempt_at FROM fiscal_documents WHERE id = $1', [document])).rows[0]).toEqual({
        next_attempt_at: null,
      }),
    { timeout: PATIENCE_MS, interval: 200 },
  );
}, 60_000);

it('emailIsRetriedByTheSchedulerAfterATemporaryFailure', async () => {
  const { s, email } = await scenarioWithEmail();
  smtp.onRecipient(email, SmtpReply.failData(451, '4.3.0 Intente más tarde'), SmtpReply.accept());

  const document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));

  // El primer intento falla; el planificador devuelve la entrega a la cola y el segundo llega.
  await awaitMail(email);
  await vi.waitFor(
    async () =>
      expect((await db.query('SELECT status, attempt_count FROM deliveries WHERE document_id = $1', [document])).rows).toEqual([
        { status: 'SENT', attempt_count: 2 },
      ]),
    { timeout: PATIENCE_MS, interval: 200 },
  );
}, 60_000);

it('un mensaje ilegible en la cola de entrega acaba en su cola de mensajes muertos', async () => {
  probe.publish(EVENTS_EXCHANGE, DELIVER_ROUTING_KEY, Buffer.from('esto no es un evento', 'utf8'));

  expect((await receive(DELIVER_DEAD_LETTER_QUEUE, PATIENCE_MS))?.toString('utf8')).toBe('esto no es un evento');

  // El worker sigue atendiendo.
  const { s, email } = await scenarioWithEmail();
  await issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'));
  await awaitMail(email);
  expect(testApp.app.get(DeliveryWorker).isConsuming()).toBe(true);
}, 90_000);

it('eventForAMissingDocumentIsDiscarded', async () => {
  const body = JSON.stringify({
    eventId: randomUUID(),
    tenantId: randomUUID(),
    documentId: randomUUID(),
    eventType: 'DOCUMENT_DUE',
  });
  probe.publish(EVENTS_EXCHANGE, ISSUE_ROUTING_KEY, Buffer.from(body, 'utf8'));

  // No es un mensaje envenenado: se descarta sin pasar por la cola de mensajes muertos.
  expect(await receive(DEAD_LETTER_QUEUE, 3_000)).toBeNull();
});

it('con la conexión cerrada a mitad de un mensaje, se vuelve a entregar y se autoriza una sola vez', async () => {
  const s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  const document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));
  const key = await accessKeyOf(db, document);
  // La consulta de autorización tarda: el worker estará a mitad del mensaje cuando se corte la conexión.
  sri.onAuthorization(key, Reply.delayed(1_500, Reply.xml(authorized(key))));

  await vi.waitFor(() => expect(sri.authorizationCalls(key)).toBeGreaterThanOrEqual(1), {
    timeout: PATIENCE_MS,
    interval: 50,
  });
  const closed = await stack.containers.rabbit.exec(['rabbitmqctl', 'close_all_connections', 'prueba']);
  expect(closed.exitCode).toBe(0);

  await awaitState(s.owner, document, 'AUTHORIZED');
  // El consumidor vuelve a abrir su canal y sigue atendiendo.
  await vi.waitFor(() => expect(testApp.app.get(DocumentWorker).isConsuming()).toBe(true), { timeout: PATIENCE_MS });
  const other = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'));
  await awaitState(s.owner, other, 'AUTHORIZED');
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM document_artifacts WHERE document_id = $1 AND kind = 'SRI_AUTHORIZATION'",
        [document],
      )
    ).rows[0],
  ).toEqual({ n: 1 });
  const transitions = await db.query("SELECT 1 FROM state_events WHERE document_id = $1 AND new_state = 'AUTHORIZED'", [
    document,
  ]);
  expect(transitions.rowCount).toBe(1);
}, 120_000);

// La última: cierra la aplicación.
it('al apagarse espera al correo en curso, que queda anotado', async () => {
  const { s, email } = await scenarioWithEmail();
  const started = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (smtp.inDelivery(email) > 0) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
  });
  smtp.onRecipient(email, SmtpReply.delayed(1_500, SmtpReply.accept()));
  const document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));
  await started;

  await testApp.app.close();

  expect(smtp.raw(email)).toHaveLength(1);
  expect((await db.query('SELECT status, attempt_count FROM deliveries WHERE document_id = $1', [document])).rows).toEqual([
    { status: 'SENT', attempt_count: 1 },
  ]);
}, 90_000);
