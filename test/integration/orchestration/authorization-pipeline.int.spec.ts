import type { Kysely } from 'kysely';
import pg from 'pg';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { DocumentPipeline } from '../../../src/orchestration/document-pipeline.js';
import { DueDocumentScheduler } from '../../../src/orchestration/due-document-scheduler.js';
import { ArtifactStore } from '../../../src/storage/artifact-store.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  accessKeyOf,
  bearer,
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

// Traducción de orchestration/AuthorizationPipelineIT.java :
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

/** Deja pasar la espera entre reintentos: el pipeline la mide desde el último intento. */
const elapseBackoff = () =>
  db.query(
    `UPDATE sri_attempts SET started_at = started_at - interval '2 hours', completed_at = completed_at - interval '2 hours'
     WHERE document_id = $1 AND outcome IS NOT NULL`,
    [document],
  );

it('receivedInvoiceBecomesAuthorized', async () => {
  expect(await advance()).toBe('AUTHORIZED');

  expect(await state()).toBe('AUTHORIZED');
  expect(await one('SELECT authorization_number FROM fiscal_documents WHERE id = $1', document)).toBe(key);
  expect((await one<Date>('SELECT authorized_at FROM fiscal_documents WHERE id = $1', document)).getTime()).toBe(
    new Date(AUTHORIZATION_DATE).getTime(),
  );
  expect((await authorizationArtifact())!.content.toString('utf8')).toBe(authorized(key));
  // Queda programado hasta que se archive.
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

  await elapseBackoff();
  expect(await advance()).toBe('AUTHORIZED');
  expect(await attempts('AUTHORIZATION')).toEqual(['PROCESSING', 'AUTHORIZED']);
  expect(await attemptCount()).toBe(0);
  expect(sri.receptionCalls(key)).toBe(1);
});

it('notFoundAfterReceptionKeepsWaiting', async () => {
  sri.onAuthorization(key, Reply.xml(notFound(key)));

  expect(await advance()).toBe('RECEIVED');
  await elapseBackoff();
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
  await elapseBackoff();
  expect(await advance()).toBe('RECEIVED');
  await elapseBackoff();
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
  await elapseBackoff();

  expect(await advance()).toBe('RECEIVED');

  expect(await nextAttemptAt()).toBeNull();
  expect(await lastReason()).toBe('SRI_RETRIES_EXHAUSTED');
  expect((await transitions()).at(-1)).toBe('RECEIVED>RECEIVED');

  // Un evento repetido no revive el seguimiento ni repite la constancia.
  const before = await transitions();
  expect(await advance()).toBe('RECEIVED');
  expect(await nextAttemptAt()).toBeNull();
  expect(await attemptCount()).toBe(5);
  expect(await transitions()).toEqual(before);
});

it('lateEventsAfterExhaustionAreDiscarded', async () => {
  sri.onAuthorization(key, Reply.xml(processing(key)));
  await advance();
  await db.query('UPDATE fiscal_documents SET attempt_count = 4 WHERE id = $1', [document]);
  await elapseBackoff();
  await advance();
  const before = await transitions();
  const calls = sri.authorizationCalls(key);

  // El evento llega cuando ya pasó la espera del último intento: el backoff ya no lo frena.
  await elapseBackoff();
  expect(await advance()).toBe('RECEIVED');

  expect(sri.authorizationCalls(key)).toBe(calls);
  expect(await nextAttemptAt()).toBeNull();
  expect(await attemptCount()).toBe(5);
  expect(await transitions()).toEqual(before);

  // El reintento manual pone la cuenta a cero y sí vuelve a consultar.
  sri.onAuthorization(key, Reply.xml(authorized(key)));
  await testApp.http.post(`/api/v1/documents/${document}/retry`).set('Authorization', bearer(s.owner)).expect(202);
  expect(await advance()).toBe('AUTHORIZED');
});

it('lateEventsAfterExhaustedSendAreDiscarded', async () => {
  sri.onReception(key, Reply.status(500, 'Internal Server Error'));
  sri.onAuthorization(key, Reply.status(503, 'Service Unavailable'));
  expect(await advance()).toBe('SENDING');
  await db.query('UPDATE fiscal_documents SET attempt_count = 4 WHERE id = $1', [document]);
  await elapseBackoff();
  expect(await advance()).toBe('SENDING');
  expect(await lastReason()).toBe('SRI_RETRIES_EXHAUSTED');
  const before = await transitions();
  const calls = sri.authorizationCalls(key);

  await elapseBackoff();
  expect(await advance()).toBe('SENDING');

  expect(sri.authorizationCalls(key)).toBe(calls);
  expect(await nextAttemptAt()).toBeNull();
  expect(await attemptCount()).toBe(5);
  expect(await transitions()).toEqual(before);
});

it('scheduledDocumentOverALoweredLimitQueriesOnceMoreAndStops', async () => {
  sri.onAuthorization(key, Reply.xml(processing(key)));
  await advance();
  // Sigue programado con más intentos que el máximo, como si la configuración lo hubiera bajado.
  await db.query('UPDATE fiscal_documents SET attempt_count = 7 WHERE id = $1', [document]);
  await elapseBackoff();

  expect(await advance()).toBe('RECEIVED');

  // Se detiene con constancia; descartarlo lo dejaría volviendo a la cola sin fin.
  expect(sri.authorizationCalls(key)).toBe(2);
  expect(await nextAttemptAt()).toBeNull();
  expect(await lastReason()).toBe('SRI_RETRIES_EXHAUSTED');
});

it('uncertainSendThatWasAuthorizedEndsAuthorized', async () => {
  sri.onReception(key, Reply.status(500, 'Internal Server Error'));
  expect(await advance()).toBe('SENDING');
  await elapseBackoff();

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
  await elapseBackoff();

  const results = await Promise.all(Array.from({ length: 5 }, () => advance()));

  // En Java las cinco consultan; aquí consulta una y las demás se descartan mientras está en curso.
  expect(results).toContain('AUTHORIZED');
  for (const result of results) expect(['AUTHORIZED', 'RECEIVED']).toContain(result);
  expect(await state()).toBe('AUTHORIZED');
  expect(sri.authorizationCalls(key)).toBe(2);
  expect(
    Number(
      await one("SELECT count(*) FROM document_artifacts WHERE document_id = $1 AND kind = 'SRI_AUTHORIZATION'", document),
    ),
  ).toBe(1);
  expect((await transitions()).filter((t) => t === 'RECEIVED>AUTHORIZED')).toHaveLength(1);
});

describe('avances duplicados en RECEIVED', () => {
  it('varios eventos a la vez hacen una sola consulta y gastan un solo intento', async () => {
    sri.onAuthorization(key, Reply.xml(processing(key)), Reply.delayed(500, Reply.xml(processing(key))));
    expect(await advance()).toBe('RECEIVED');
    await elapseBackoff();

    await Promise.all(Array.from({ length: 5 }, () => advance()));

    expect(sri.authorizationCalls(key)).toBe(2);
    expect(await attempts('AUTHORIZATION')).toEqual(['PROCESSING', 'PROCESSING']);
    expect(await attemptCount()).toBe(2);
  });

  it.each([
    ['PROCESSING', () => Reply.xml(processing(key))],
    ['UNCERTAIN', () => Reply.status(503, 'Service Unavailable')],
  ])('tras %s, un evento repetido dentro de la espera no consulta, no gasta intento ni retrasa el siguiente', async (_o, reply) => {
    sri.onAuthorization(key, reply());
    await advance();
    const scheduled = (await nextAttemptAt())!;

    for (let i = 0; i < 4; i++) expect(await advance()).toBe('RECEIVED');

    expect(sri.authorizationCalls(key)).toBe(1);
    expect(await attemptCount()).toBe(1);
    expect((await nextAttemptAt())!.getTime()).toBeLessThanOrEqual(scheduled.getTime());

    await elapseBackoff();
    await advance();
    expect(sri.authorizationCalls(key)).toBe(2);
    expect(await attemptCount()).toBe(2);
  });

  it('un descarte no deja el comprobante esperando el plazo de reentrega del planificador', async () => {
    sri.onAuthorization(key, Reply.xml(processing(key)));
    await advance();
    // Lo que hace DueDocumentScheduler al encolar: cinco minutos.
    await db.query("UPDATE fiscal_documents SET next_attempt_at = now() + interval '5 minutes' WHERE id = $1", [document]);

    await advance();

    expect((await nextAttemptAt())!.getTime()).toBeLessThan(Date.now() + 5_000);
  });

  it('el reintento manual consulta ya, y el evento que además genera el planificador se descarta', async () => {
    sri.onAuthorization(key, Reply.xml(processing(key)));
    await advance();
    await testApp.http.post(`/api/v1/documents/${document}/retry`).set('Authorization', bearer(s.owner)).expect(202);
    await testApp.app.get(DueDocumentScheduler).enqueueDue();

    await advance(); // el evento del reintento
    await advance(); // el DOCUMENT_DUE del planificador

    expect(sri.authorizationCalls(key)).toBe(2);
    expect(await attemptCount()).toBe(1);
    expect((await nextAttemptAt())!.getTime()).toBeLessThan(Date.now() + 5_000);
  });

  /** Una consulta abierta hace ese tiempo, como si el proceso hubiera muerto a mitad. */
  async function openQuery(seconds: number): Promise<void> {
    await db.query(
      `INSERT INTO sri_attempts (tenant_id, document_id, operation, environment, started_at)
       VALUES ($1, $2, 'AUTHORIZATION', '1', now() - make_interval(secs => $3))`,
      [s.tenant, document, seconds],
    );
  }

  it('una consulta en curso se respeta; una que pasó su plazo se abandona y se repite', async () => {
    sri.onAuthorization(key, Reply.xml(processing(key)), Reply.xml(authorized(key)));
    await advance();
    await elapseBackoff();
    await openQuery(1);

    expect(await advance()).toBe('RECEIVED');
    expect(sri.authorizationCalls(key)).toBe(1);

    await db.query("UPDATE sri_attempts SET started_at = now() - interval '10 minutes' WHERE document_id = $1 AND outcome IS NULL", [
      document,
    ]);
    expect(await advance()).toBe('AUTHORIZED');
    expect(await attempts('AUTHORIZATION')).toEqual(['PROCESSING', 'ABANDONED', 'AUTHORIZED']);
  });

  it('mientras consulta, el comprobante queda programado para retomarse si el proceso muere', async () => {
    sri.onAuthorization(key, Reply.delayed(800, Reply.xml(authorized(key))));
    const running = advance();
    await vi.waitFor(() => expect(sri.authorizationCalls(key)).toBe(1), { timeout: 10_000, interval: 20 });

    // Conexión 2 s + lectura 2 s + margen de 30 s.
    const wait = (await nextAttemptAt())!.getTime() - Date.now();
    expect(wait).toBeGreaterThan(25_000);
    expect(wait).toBeLessThan(35_000);
    expect(await running).toBe('AUTHORIZED');
  });

  it('el resultado de una consulta ya abandonada no se aplica', async () => {
    sri.onAuthorization(key, Reply.delayed(800, Reply.xml(processing(key))));
    const running = advance();
    await vi.waitFor(() => expect(sri.authorizationCalls(key)).toBe(1), { timeout: 10_000, interval: 20 });
    await db.query(
      "UPDATE sri_attempts SET outcome = 'ABANDONED', completed_at = clock_timestamp() WHERE document_id = $1 AND outcome IS NULL",
      [document],
    );

    expect(await running).toBe('RECEIVED');
    expect(await attemptCount()).toBe(0);
  });
});

it('artifactIsDownloadable', async () => {
  await pipeline.advance(s.tenant, document);

  const downloaded = await testApp.http
    .get(`/api/v1/documents/${document}/artifacts/sri-authorization`)
    .set('Authorization', bearer(s.owner))
    .responseType('blob')
    .expect(200);

  expect((downloaded.body as Buffer).toString('utf8')).toBe(authorized(key));
});
