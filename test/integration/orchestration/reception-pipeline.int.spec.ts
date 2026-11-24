import type { Kysely } from 'kysely';
import pg from 'pg';
import { ApiException } from '../../../src/common/api-exception.js';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { DocumentPipeline } from '../../../src/orchestration/document-pipeline.js';
import { ArtifactStore } from '../../../src/storage/artifact-store.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  accessKeyOf,
  billingScenario,
  invoiceJson,
  issueInvoice,
  newOwner,
  processDocument,
  uploadTestCertificate,
  type BillingScenario,
} from '../../support/scenario.js';
import { errorMsg, msg, notFound, emptyAuthorizationResponse, processing, received, returned } from '../../support/sri-soap-samples.js';
import { Reply, SriStub, sriTestEnv } from '../../support/sri-stub.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de orchestration/ReceptionPipelineIT.java: envío a la recepción del SRI (simulado) y conciliación
// de los envíos de resultado incierto.
let stack: StackHandle;
let sri: SriStub;
let testApp: TestApp;
let db: pg.Client;
let kysely: Kysely<DB>;
let pipeline: DocumentPipeline;

beforeAll(async () => {
  stack = await startStack();
  sri = await SriStub.start();
  testApp = await startTestApp(stack, sriTestEnv(sri));
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  kysely = testApp.app.get(DATABASE);
  pipeline = testApp.app.get(DocumentPipeline);
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await sri?.close();
  await stack?.stop();
});

let s: BillingScenario;
let document: string;
let key: string;
beforeEach(async () => {
  s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));
  key = await accessKeyOf(db, document);
  // Por defecto la autorización queda pendiente: estas pruebas tratan de la recepción.
  sri.onAuthorization(key, Reply.xml(processing(key)));
});

const advance = (tenant = s.tenant, id = document) => pipeline.advance(tenant, id);
const one = async <T>(sql: string, ...params: unknown[]): Promise<T> =>
  Object.values((await db.query(sql, params)).rows[0] as Record<string, unknown>)[0] as T;
const state = () => one<string>('SELECT state FROM fiscal_documents WHERE id = $1', document);
const transitions = async () =>
  (
    await db.query<{ t: string }>(
      "SELECT coalesce(previous_state, '-') || '>' || new_state AS t FROM state_events WHERE document_id = $1 ORDER BY event_time",
      [document],
    )
  ).rows.map((r) => r.t);
const lastReason = () =>
  one<string>('SELECT reason FROM state_events WHERE document_id = $1 ORDER BY event_time DESC LIMIT 1', document);
const attempts = async (operation: string) =>
  (
    await db.query<{ o: string }>(
      "SELECT coalesce(outcome, 'IN_FLIGHT') AS o FROM sri_attempts WHERE document_id = $1 AND operation = $2 ORDER BY started_at",
      [document, operation],
    )
  ).rows.map((r) => r.o);
const nextAttemptAt = () => one<Date | null>('SELECT next_attempt_at FROM fiscal_documents WHERE id = $1', document);
const attemptCount = () => one<number>('SELECT attempt_count FROM fiscal_documents WHERE id = $1', document);
const signedXml = async () => (await testApp.app.get(ArtifactStore).find(kysely, s.tenant, document, 'XML_SIGNED'))!.content;
const count = <T>(items: T[], item: T) => items.filter((i) => i === item).length;

/** Deja pasar la espera entre reintentos: el pipeline la mide desde el último intento. */
const elapseBackoff = () =>
  db.query(
    `UPDATE sri_attempts SET started_at = started_at - interval '2 hours', completed_at = completed_at - interval '2 hours'
     WHERE document_id = $1 AND outcome IS NOT NULL`,
    [document],
  );

it('signedInvoiceIsSentAndReceived', async () => {
  expect(await advance()).toBe('RECEIVED');

  expect(await state()).toBe('RECEIVED');
  expect(sri.receptionCalls(key)).toBe(1);
  expect(sri.lastReceptionXml(key)!.equals(await signedXml())).toBe(true);
  expect(await transitions()).toEqual([
    '->RESERVED',
    'RESERVED>GENERATED',
    'GENERATED>SIGNED',
    'SIGNED>SENDING',
    'SENDING>RECEIVED',
  ]);
  expect(await attempts('RECEPTION')).toEqual(['RECEIVED']);
  expect(
    await one(
      "SELECT sri_status || '/' || http_status || '/' || environment FROM sri_attempts WHERE document_id = $1 AND operation = 'RECEPTION'",
      document,
    ),
  ).toBe('RECIBIDA/200/1');
  expect(await nextAttemptAt()).not.toBeNull();
});

it('returnedInvoiceKeepsEveryMessage', async () => {
  sri.onReception(
    key,
    Reply.xml(
      returned(
        key,
        msg('35', 'DOCUMENTO INVÁLIDO', 'Se encontró un error en la estructura', 'ERROR'),
        errorMsg('45', 'SECUENCIAL REGISTRADO'),
      ),
    ),
  );

  expect(await advance()).toBe('RETURNED');

  expect(await state()).toBe('RETURNED');
  expect(await lastReason()).toBe('35, 45');
  expect(await attempts('RECEPTION')).toEqual(['RETURNED']);
  const messages = await db.query<{ m: string }>(
    `SELECT m.identifier || '|' || m.message || '|' || coalesce(m.additional_info, '') || '|' || m.type AS m
     FROM sri_messages m JOIN sri_attempts a ON a.id = m.attempt_id WHERE a.document_id = $1 ORDER BY m.position`,
    [document],
  );
  expect(messages.rows.map((r) => r.m)).toEqual([
    '35|DOCUMENTO INVÁLIDO|Se encontró un error en la estructura|ERROR',
    '45|SECUENCIAL REGISTRADO||ERROR',
  ]);
  expect(
    await one<string>(
      "SELECT convert_from(response, 'UTF8') FROM sri_attempts WHERE document_id = $1 AND operation = 'RECEPTION'",
      document,
    ),
  ).toContain('<estado>DEVUELTA</estado>');
  expect(await nextAttemptAt()).toBeNull();
  expect(sri.authorizationCalls(key)).toBe(0);

  // Un comprobante devuelto no se vuelve a tocar por su cuenta.
  expect(await advance()).toBe('RETURNED');
  expect(sri.receptionCalls(key)).toBe(1);
});

it('alreadyRegisteredCountsAsReceived', async () => {
  sri.onReception(key, Reply.xml(returned(key, errorMsg('70', 'CLAVE DE ACCESO EN PROCESAMIENTO'))));

  expect(await advance()).toBe('RECEIVED');

  expect(await attempts('RECEPTION')).toEqual(['ALREADY_REGISTERED']);
  expect(
    await one('SELECT sri_status FROM sri_attempts WHERE document_id = $1 AND operation = $2', document, 'RECEPTION'),
  ).toBe('DEVUELTA');
  expect(await lastReason()).toBe('ALREADY_REGISTERED: 70');
  expect(await nextAttemptAt()).not.toBeNull();
});

it('registeredAccessKeyCountsAsReceived', async () => {
  sri.onReception(key, Reply.xml(returned(key, errorMsg('43', 'CLAVE ACCESO REGISTRADA'))));

  expect(await advance()).toBe('RECEIVED');
  expect(await attempts('RECEPTION')).toEqual(['ALREADY_REGISTERED']);
});

it('uncertainSendIsNeverResentBlindly', async () => {
  sri.onReception(key, Reply.status(500, 'Internal Server Error'));

  expect(await advance()).toBe('SENDING');

  expect(await attempts('RECEPTION')).toEqual(['UNCERTAIN']);
  expect(await attemptCount()).toBe(1);
  expect((await nextAttemptAt())!.getTime()).toBeGreaterThan(Date.now());
  // No se consultó nada todavía: la conciliación llega con el siguiente avance.
  expect(sri.authorizationCalls(key)).toBe(0);

  // El SRI sí lo había recibido: al conciliar se descubre y no se envía otra vez.
  await elapseBackoff();
  expect(await advance()).not.toBe('SENDING');

  expect(sri.receptionCalls(key)).toBe(1);
  expect(sri.authorizationCalls(key)).toBeGreaterThanOrEqual(1);
  expect(await transitions()).toContain('SENDING>RECEIVED');
  expect(await transitions()).not.toContain('SENDING>SIGNED');
});

it('uncertainSendIsResentOnlyWhenTheSriDoesNotKnowTheKey', async () => {
  sri.onReception(key, Reply.dropConnection(), Reply.xml(received()));
  sri.onAuthorization(key, Reply.xml(notFound(key)));
  expect(await advance()).toBe('SENDING');
  await elapseBackoff();

  expect(await advance()).toBe('RECEIVED');

  expect(sri.receptionCalls(key)).toBe(2);
  const all = await transitions();
  const from = all.indexOf('SIGNED>SENDING');
  expect(all.slice(from)).toEqual(['SIGNED>SENDING', 'SENDING>SIGNED', 'SIGNED>SENDING', 'SENDING>RECEIVED']);
  expect(
    await one(
      "SELECT reason FROM state_events WHERE document_id = $1 AND previous_state = 'SENDING' AND new_state = 'SIGNED'",
      document,
    ),
  ).toBe('RESEND_AFTER_NOT_FOUND');
  expect(await attempts('RECEPTION')).toEqual(['UNCERTAIN', 'RECEIVED']);
  // El mismo XML firmado, con la misma clave.
  expect(sri.lastReceptionXml(key)!.equals(await signedXml())).toBe(true);
});

it('notFoundThatIsNotAboutThisKeyDoesNotTriggerAResend', async () => {
  sri.onReception(key, Reply.status(500, 'Internal Server Error'));
  sri.onAuthorization(key, Reply.xml(notFound('9'.repeat(49))), Reply.xml(emptyAuthorizationResponse()));
  await advance();

  await elapseBackoff();
  expect(await advance()).toBe('SENDING');
  await elapseBackoff();
  expect(await advance()).toBe('SENDING');

  expect(sri.receptionCalls(key)).toBe(1);
  expect(await attempts('AUTHORIZATION')).toEqual(['MISMATCH', 'MISMATCH']);
  expect(await transitions()).not.toContain('SENDING>SIGNED');
  expect(await attemptCount()).toBe(3);
});

it('concurrentReconcilersResendOnce', async () => {
  sri.onReception(key, Reply.status(500, 'Internal Server Error'), Reply.delayed(600, Reply.xml(received())));
  sri.onAuthorization(key, Reply.delayed(300, Reply.xml(notFound(key))));
  expect(await advance()).toBe('SENDING');
  await elapseBackoff();

  await Promise.all(Array.from({ length: 5 }, () => advance()));

  // El envío incierto y un único reenvío.
  expect(sri.receptionCalls(key)).toBe(2);
  expect(count(await transitions(), 'SENDING>SIGNED')).toBe(1);
  expect(await state()).toBe('RECEIVED');
});

it('sriDownWhileReconcilingKeepsTheDocumentSending', async () => {
  sri.onReception(key, Reply.status(500, 'Internal Server Error'));
  sri.onAuthorization(key, Reply.status(503, 'Service Unavailable'));
  await advance();
  await elapseBackoff();

  expect(await advance()).toBe('SENDING');

  expect(sri.receptionCalls(key)).toBe(1);
  expect(await attempts('AUTHORIZATION')).toEqual(['UNCERTAIN']);
  expect(await attemptCount()).toBe(2);
  expect((await nextAttemptAt())!.getTime()).toBeGreaterThan(Date.now());
});

it('varias conciliaciones a la vez hacen una sola consulta y gastan un solo intento', async () => {
  sri.onReception(key, Reply.status(500, 'Internal Server Error'));
  sri.onAuthorization(key, Reply.delayed(500, Reply.status(503, 'Service Unavailable')));
  await advance();
  await elapseBackoff();

  await Promise.all(Array.from({ length: 5 }, () => advance()));

  expect(sri.authorizationCalls(key)).toBe(1);
  expect(await attemptCount()).toBe(2);
});

it('un evento repetido dentro de la espera no concilia antes de tiempo', async () => {
  sri.onReception(key, Reply.status(500, 'Internal Server Error'));
  await advance();

  for (let i = 0; i < 4; i++) expect(await advance()).toBe('SENDING');

  expect(sri.authorizationCalls(key)).toBe(0);
  expect(await attemptCount()).toBe(1);
});

/** Deja el documento como si el proceso hubiera muerto en mitad del envío. */
async function leaveSendInFlightSince(seconds: number): Promise<void> {
  await db.query("UPDATE fiscal_documents SET state = 'SENDING' WHERE id = $1", [document]);
  await db.query(
    `INSERT INTO sri_attempts (tenant_id, document_id, operation, environment, started_at)
     VALUES ($1, $2, 'RECEPTION', '1', now() - make_interval(secs => $3))`,
    [s.tenant, document, seconds],
  );
}

it('abandonedSendIsResolvedByQueryingFirst', async () => {
  await advance();
  const receptionsBefore = sri.receptionCalls(key);
  await db.query('DELETE FROM sri_messages WHERE attempt_id IN (SELECT id FROM sri_attempts WHERE document_id = $1)', [
    document,
  ]);
  await db.query('DELETE FROM sri_attempts WHERE document_id = $1', [document]);
  await leaveSendInFlightSince(600);

  expect(await advance()).not.toBe('SENDING');

  expect(await attempts('RECEPTION')).toEqual(['ABANDONED']);
  expect(sri.receptionCalls(key)).toBe(receptionsBefore);
  expect(sri.authorizationCalls(key)).toBeGreaterThanOrEqual(1);
});

it('un worker que muere tras pasar a SENDING se concilia consultando antes de reenviar', async () => {
  // El proceso firmó, pasó a SENDING y murió antes de llamar: el SRI no conoce la clave.
  expect(await processDocument(testApp.app, s.tenant, document)).toBe('SIGNED');
  await leaveSendInFlightSince(600);
  sri.onAuthorization(key, Reply.xml(notFound(key)), Reply.xml(processing(key)));
  const receptionsBefore = sri.receptionCalls(key);
  const authorizationsBefore = sri.authorizationCalls(key);

  expect(await advance()).toBe('RECEIVED');

  // Primero la consulta, después el único reenvío.
  expect(sri.authorizationCalls(key)).toBeGreaterThan(authorizationsBefore);
  expect(sri.receptionCalls(key)).toBe(receptionsBefore + 1);
  expect(await attempts('RECEPTION')).toEqual(['ABANDONED', 'RECEIVED']);
  expect((await attempts('AUTHORIZATION'))[0]).toBe('NOT_FOUND');
});

it('sendInFlightIsLeftAlone', async () => {
  await advance();
  const receptions = sri.receptionCalls(key);
  const authorizations = sri.authorizationCalls(key);
  await leaveSendInFlightSince(1);

  expect(await advance()).toBe('SENDING');

  expect(sri.receptionCalls(key)).toBe(receptions);
  expect(sri.authorizationCalls(key)).toBe(authorizations);
  // El intento abierto sigue abierto: nadie lo dio por abandonado.
  expect((await attempts('RECEPTION')).sort()).toEqual(['IN_FLIGHT', 'RECEIVED']);
});

it('concurrentAdvanceSendsOnce', async () => {
  sri.onReception(key, Reply.delayed(500, Reply.xml(received())));

  const results = await Promise.all(Array.from({ length: 5 }, () => advance()));

  for (const result of results) expect(['SENDING', 'RECEIVED']).toContain(result);
  expect(sri.receptionCalls(key)).toBe(1);
  expect(await state()).toBe('RECEIVED');
  expect(count(await transitions(), 'SIGNED>SENDING')).toBe(1);
  expect(Number(await one('SELECT count(*) FROM document_artifacts WHERE document_id = $1', document))).toBe(2);
});

it('disabledEnvironmentStaysSignedWithoutCallingTheSri', async () => {
  const production = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, production.owner, production.taxpayer);
  // Emisor ya activado en producción; lo que está cerrado es la transmisión de la plataforma.
  await db.query(
    "UPDATE taxpayers SET default_environment = '2', production_enabled_at = now() WHERE id = $1",
    [production.taxpayer],
  );
  const invoice = await issueInvoice(testApp.http, production.owner, invoiceJson(production, '1', '11.50'));
  const productionKey = await one<string>(
    "SELECT access_key FROM fiscal_documents WHERE id = $1 AND environment = '2'",
    invoice,
  );

  expect(await pipeline.advance(production.tenant, invoice)).toBe('SIGNED');

  expect(sri.receptionCalls(productionKey)).toBe(0);
  expect(sri.authorizationCalls(productionKey)).toBe(0);
  expect(await one('SELECT next_attempt_at FROM fiscal_documents WHERE id = $1', invoice)).toBeNull();
  expect(Number(await one('SELECT count(*) FROM sri_attempts WHERE document_id = $1', invoice))).toBe(0);
});

it('retriesAreExhausted', async () => {
  sri.onReception(key, Reply.status(500, 'Internal Server Error'));
  sri.onAuthorization(key, Reply.status(503, 'Service Unavailable'));
  await advance();
  // El máximo de intentos de las pruebas es 5.
  await db.query('UPDATE fiscal_documents SET attempt_count = 4 WHERE id = $1', [document]);
  await elapseBackoff();

  expect(await advance()).toBe('SENDING');

  expect(await nextAttemptAt()).toBeNull();
  expect(await attemptCount()).toBe(5);
  expect(await lastReason()).toBe('SRI_RETRIES_EXHAUSTED');
  expect((await transitions()).at(-1)).toBe('SENDING>SENDING');
});

it('signatureFailureDoesNotReachTheSri', async () => {
  const noCertificate = await billingScenario(testApp.http, db);
  const invoice = await issueInvoice(testApp.http, noCertificate.owner, invoiceJson(noCertificate, '1', '11.50'));
  const otherKey = await accessKeyOf(db, invoice);

  expect(await pipeline.advance(noCertificate.tenant, invoice)).toBe('SIGNATURE_FAILED');

  expect(sri.receptionCalls(otherKey)).toBe(0);
  expect(await one('SELECT next_attempt_at FROM fiscal_documents WHERE id = $1', invoice)).toBeNull();
});

it('foreignDocumentIsNotFound', async () => {
  const { tenant: otherTenant } = await newOwner(testApp.http);

  await expect(advance(otherTenant)).rejects.toBeInstanceOf(ApiException);
  expect(await state()).toBe('RESERVED');
  expect(sri.receptionCalls(key)).toBe(0);
});
