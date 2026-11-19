import type { Kysely } from 'kysely';
import pg from 'pg';
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
  uploadTestCertificate,
  type BillingScenario,
} from '../../support/scenario.js';
import {
  AUTHORIZATION_DATE,
  authorized,
  authorizedIn,
  errorMsg,
  notAuthorized,
  notFound,
  processing,
} from '../../support/sri-soap-samples.js';
import { Reply, SriStub, sriTestEnv } from '../../support/sri-stub.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de orchestration/AuthorizationPipelineIT.java (salvo artifactIsDownloadable, que llega en E5):
// consulta de autorización al SRI (simulado) y cierre del comprobante.
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
});

const advance = () => pipeline.advance(s.tenant, document);
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
const authorizationArtifact = () => testApp.app.get(ArtifactStore).find(kysely, s.tenant, document, 'SRI_AUTHORIZATION');

it('receivedInvoiceBecomesAuthorized', async () => {
  expect(await advance()).toBe('AUTHORIZED');

  expect(await state()).toBe('AUTHORIZED');
  expect(await one('SELECT authorization_number FROM fiscal_documents WHERE id = $1', document)).toBe(key);
  expect((await one<Date>('SELECT authorized_at FROM fiscal_documents WHERE id = $1', document)).getTime()).toBe(
    new Date(AUTHORIZATION_DATE).getTime(),
  );
  expect((await authorizationArtifact())!.content.toString('utf8')).toBe(authorized(key));
  // Queda programado hasta que se archive (E5).
  expect((await nextAttemptAt())!.getTime()).toBeGreaterThan(Date.now());
  expect(await transitions()).toEqual([
    '->RESERVED',
    'RESERVED>GENERATED',
    'GENERATED>SIGNED',
    'SIGNED>SENDING',
    'SENDING>RECEIVED',
    'RECEIVED>AUTHORIZED',
  ]);
  expect(await attempts('AUTHORIZATION')).toEqual(['AUTHORIZED']);
  // La respuesta ya está en el artefacto: el intento no la duplica, pero conserva la advertencia.
  expect(
    await one("SELECT response IS NULL FROM sri_attempts WHERE document_id = $1 AND operation = 'AUTHORIZATION'", document),
  ).toBe(true);
  const messages = await db.query<{ m: string }>(
    `SELECT m.identifier || '|' || m.type AS m FROM sri_messages m JOIN sri_attempts a ON a.id = m.attempt_id
     WHERE a.document_id = $1 AND a.operation = 'AUTHORIZATION'`,
    [document],
  );
  expect(messages.rows.map((r) => r.m)).toEqual(['60|ADVERTENCIA']);
  // Y deja el aviso para archivarlo y entregarlo.
  const outbox = await db.query(
    "SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DOCUMENT_AUTHORIZED'",
    [document],
  );
  expect(outbox.rows).toEqual([{ payload: { documentId: document } }]);
});

it('notAuthorizedKeepsTheReasons', async () => {
  sri.onAuthorization(
    key,
    Reply.xml(notAuthorized(key, 'NO AUTORIZADO', errorMsg('39', 'FIRMA INVALIDA'), errorMsg('52', 'ERROR EN DIFERENCIAS'))),
  );

  expect(await advance()).toBe('NOT_AUTHORIZED');

  expect(await state()).toBe('NOT_AUTHORIZED');
  expect(await lastReason()).toBe('39, 52');
  expect(await authorizationArtifact()).toBeNull();
  expect(await nextAttemptAt()).toBeNull();
  const attempt = await one<string>(
    "SELECT sri_status || '|' || convert_from(response, 'UTF8') FROM sri_attempts WHERE document_id = $1 AND operation = 'AUTHORIZATION'",
    document,
  );
  expect(attempt.startsWith('NO AUTORIZADO|')).toBe(true);
  expect(attempt).toContain('FIRMA INVALIDA');

  // Un comprobante no autorizado no se vuelve a consultar por su cuenta.
  expect(await advance()).toBe('NOT_AUTHORIZED');
  expect(sri.authorizationCalls(key)).toBe(1);
});

it('processingIsPolledAgainLater', async () => {
  sri.onAuthorization(key, Reply.xml(processing(key)), Reply.xml(authorized(key)));

  expect(await advance()).toBe('RECEIVED');

  expect(await attempts('AUTHORIZATION')).toEqual(['PROCESSING']);
  expect(await attemptCount()).toBe(1);
  expect((await nextAttemptAt())!.getTime()).toBeGreaterThan(Date.now());

  expect(await advance()).toBe('AUTHORIZED');
  expect(await attempts('AUTHORIZATION')).toEqual(['PROCESSING', 'AUTHORIZED']);
  expect(await attemptCount()).toBe(0);
  expect(sri.receptionCalls(key)).toBe(1);
});

it('notFoundAfterReceptionKeepsWaiting', async () => {
  sri.onAuthorization(key, Reply.xml(notFound(key)));

  expect(await advance()).toBe('RECEIVED');
  expect(await advance()).toBe('RECEIVED');

  expect(await attempts('AUTHORIZATION')).toEqual(['NOT_FOUND', 'NOT_FOUND']);
  expect(sri.receptionCalls(key)).toBe(1);
  expect(await attemptCount()).toBe(2);
});

it('authorizationForAnotherKeyOrEnvironmentIsNotAccepted', async () => {
  const otherKey = '9'.repeat(49);
  sri.onAuthorization(
    key,
    Reply.xml(authorized(otherKey)),
    Reply.xml(authorizedIn(key, 'PRODUCCIÓN')),
    Reply.xml(notAuthorized(otherKey, 'NO AUTORIZADO', errorMsg('39', 'FIRMA INVALIDA'))),
  );

  expect(await advance()).toBe('RECEIVED');
  expect(await advance()).toBe('RECEIVED');
  expect(await advance()).toBe('RECEIVED');

  expect(await attempts('AUTHORIZATION')).toEqual(['MISMATCH', 'MISMATCH', 'MISMATCH']);
  expect(await authorizationArtifact()).toBeNull();
  expect(await one('SELECT authorization_number FROM fiscal_documents WHERE id = $1', document)).toBeNull();
  // La respuesta que no se aceptó queda guardada como evidencia.
  expect(
    Number(
      await one(
        "SELECT count(*) FROM sri_attempts WHERE document_id = $1 AND outcome = 'MISMATCH' AND response IS NOT NULL",
        document,
      ),
    ),
  ).toBe(3);
});

it('sriDownWhileAuthorizingIsRetried', async () => {
  sri.onAuthorization(key, Reply.status(503, 'Service Unavailable'));

  expect(await advance()).toBe('RECEIVED');

  expect(await attempts('AUTHORIZATION')).toEqual(['UNCERTAIN']);
  expect((await nextAttemptAt())!.getTime()).toBeGreaterThan(Date.now());
});

it('authorizationRetriesAreExhausted', async () => {
  sri.onAuthorization(key, Reply.xml(processing(key)));
  await advance();
  // El máximo de intentos de las pruebas es 5.
  await db.query('UPDATE fiscal_documents SET attempt_count = 4 WHERE id = $1', [document]);

  expect(await advance()).toBe('RECEIVED');

  expect(await nextAttemptAt()).toBeNull();
  expect(await lastReason()).toBe('SRI_RETRIES_EXHAUSTED');
  expect((await transitions()).at(-1)).toBe('RECEIVED>RECEIVED');
});

it('uncertainSendThatWasAuthorizedEndsAuthorized', async () => {
  sri.onReception(key, Reply.status(500, 'Internal Server Error'));
  expect(await advance()).toBe('SENDING');

  expect(await advance()).toBe('AUTHORIZED');

  expect(sri.receptionCalls(key)).toBe(1);
  expect(await authorizationArtifact()).not.toBeNull();
  expect((await transitions()).slice(-3)).toEqual(['SIGNED>SENDING', 'SENDING>RECEIVED', 'RECEIVED>AUTHORIZED']);
});

it('authorizedDocumentIsNeverTouchedAgain', async () => {
  await advance();
  const version = await one<string>('SELECT version FROM fiscal_documents WHERE id = $1', document);
  const receptions = sri.receptionCalls(key);
  const authorizations = sri.authorizationCalls(key);

  expect(await advance()).toBe('AUTHORIZED');

  expect(sri.receptionCalls(key)).toBe(receptions);
  expect(sri.authorizationCalls(key)).toBe(authorizations);
  expect(await one<string>('SELECT version FROM fiscal_documents WHERE id = $1', document)).toBe(version);
});

it('concurrentAuthorizationStoresOneArtifact', async () => {
  sri.onAuthorization(key, Reply.xml(processing(key)), Reply.xml(authorized(key)));
  expect(await advance()).toBe('RECEIVED');

  const results = await Promise.all(Array.from({ length: 5 }, () => advance()));

  expect(results).toEqual(Array(5).fill('AUTHORIZED'));
  expect(
    Number(
      await one("SELECT count(*) FROM document_artifacts WHERE document_id = $1 AND kind = 'SRI_AUTHORIZATION'", document),
    ),
  ).toBe(1);
  expect((await transitions()).filter((t) => t === 'RECEIVED>AUTHORIZED')).toHaveLength(1);
});
