import type { Kysely } from 'kysely';
import pg from 'pg';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { DocumentArchiver } from '../../../src/delivery/document-archiver.js';
import { DocumentPipeline } from '../../../src/orchestration/document-pipeline.js';
import { parseSigned } from '../../../src/signature/xades-profile.js';
import { XadesVerifier } from '../../../src/signature/xades-verifier.js';
import type { ArtifactKind } from '../../../src/storage/artifact-kind.js';
import { ArtifactStore } from '../../../src/storage/artifact-store.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { pdfText } from '../../support/pdf-inspect.js';
import {
  accessKeyOf,
  bearer,
  billingScenario,
  invoiceJson,
  issueInvoice,
  newOwner,
  uploadTestCertificate,
  type BillingScenario,
} from '../../support/scenario.js';
import { errorMsg, notAuthorized, processing } from '../../support/sri-soap-samples.js';
import { Reply, SriStub, sriTestEnv } from '../../support/sri-stub.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de delivery/DocumentArchiverIT.java: XML autorizado y RIDE como artefactos descargables. La aplicación
// corre con dos conexiones: quien archiva con el comprobante bloqueado no puede pedir otra.
let stack: StackHandle;
let sri: SriStub;
let testApp: TestApp;
let db: pg.Client;
let kysely: Kysely<DB>;
let pipeline: DocumentPipeline;
let archiver: DocumentArchiver;
let artifacts: ArtifactStore;

beforeAll(async () => {
  stack = await startStack();
  sri = await SriStub.start();
  testApp = await startTestApp(stack, { ...sriTestEnv(sri), DB_POOL_SIZE: '2' });
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  kysely = testApp.app.get(DATABASE);
  pipeline = testApp.app.get(DocumentPipeline);
  archiver = testApp.app.get(DocumentArchiver);
  artifacts = testApp.app.get(ArtifactStore);
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

const artifact = async (kind: ArtifactKind) => (await artifacts.find(kysely, s.tenant, document, kind))!;

const count = async (sqlText: string) =>
  (await db.query<{ n: number }>(sqlText, [document])).rows[0]!.n;
const artifactCount = () => count('SELECT count(*)::int AS n FROM document_artifacts WHERE document_id = $1');
const authorizedEvents = () =>
  count("SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'DOCUMENT_AUTHORIZED'");

async function nextAttemptAt(): Promise<Date | null> {
  const row = await db.query<{ next_attempt_at: Date | null }>(
    'SELECT next_attempt_at FROM fiscal_documents WHERE id = $1',
    [document],
  );
  return row.rows[0]!.next_attempt_at;
}

const minutes = (date: Date | null) => (date!.getTime() - Date.now()) / 60_000;

it('authorizedInvoiceIsArchivedWithXmlAndRide', async () => {
  expect(await pipeline.advance(s.tenant, document)).toBe('AUTHORIZED');

  expect(await archiver.archive(s.tenant, document)).toBe(true);

  // El comprobante que va dentro del XML autorizado es, byte a byte, el que se firmó y envió.
  const signed = (await artifact('XML_SIGNED')).content;
  const xml = (await artifact('XML_AUTHORIZED')).content;
  const embedded = Buffer.from(parseSigned(xml).getElementsByTagName('comprobante').item(0)!.textContent!, 'utf8');
  expect(embedded.equals(signed)).toBe(true);
  expect(testApp.app.get(XadesVerifier).verify(embedded).errors).toEqual([]);
  for (const part of [
    `<numeroAutorizacion>${key}</numeroAutorizacion>`,
    '<ambiente>PRUEBAS</ambiente>',
    '<fechaAutorizacion>2012-03-05T16:57:34.997-05:00</fechaAutorizacion>',
  ]) {
    expect(xml.toString('utf8')).toContain(part);
  }

  const text = await pdfText((await artifact('RIDE_PDF')).content);
  for (const part of [key, s.ruc, '001-001-', 'TOTAL', '23.00', 'María Pérez', '05/03/2012 16:57:34']) {
    expect(text).toContain(part);
  }
  expect(await artifactCount()).toBe(5);
  expect(await nextAttemptAt()).toBeNull();
  expect((await db.query('SELECT state FROM fiscal_documents WHERE id = $1', [document])).rows[0]).toEqual({
    state: 'AUTHORIZED',
  });
});

it('archivingTwiceChangesNothing', async () => {
  await pipeline.advance(s.tenant, document);
  await archiver.archive(s.tenant, document);
  const ride = (await artifact('RIDE_PDF')).sha256;
  const xml = (await artifact('XML_AUTHORIZED')).sha256;

  expect(await archiver.archive(s.tenant, document)).toBe(true);

  expect((await artifact('RIDE_PDF')).sha256).toBe(ride);
  expect((await artifact('XML_AUTHORIZED')).sha256).toBe(xml);
  expect(await artifactCount()).toBe(5);
});

it('concurrentArchivingStoresEachArtifactOnce', async () => {
  await pipeline.advance(s.tenant, document);

  const results = await Promise.all(Array.from({ length: 4 }, () => archiver.archive(s.tenant, document)));

  expect(results).toEqual([true, true, true, true]);
  expect(await artifactCount()).toBe(5);
});

it('onlyAuthorizedDocumentsAreArchived', async () => {
  expect(await archiver.archive(s.tenant, document), 'RESERVED').toBe(false);

  sri.onAuthorization(
    key,
    Reply.xml(processing(key)),
    Reply.xml(notAuthorized(key, 'NO AUTORIZADO', errorMsg('39', 'FIRMA INVALIDA'))),
  );
  expect(await pipeline.advance(s.tenant, document)).toBe('RECEIVED');
  expect(await archiver.archive(s.tenant, document), 'RECEIVED').toBe(false);

  // La consulta se espacia (diferencia de E4): la siguiente sale cuando pasa la espera.
  await vi.waitFor(async () => expect(await pipeline.advance(s.tenant, document)).toBe('NOT_AUTHORIZED'), {
    timeout: 20_000,
    interval: 250,
  });
  expect(await archiver.archive(s.tenant, document), 'NOT_AUTHORIZED').toBe(false);

  expect(await artifacts.find(kysely, s.tenant, document, 'RIDE_PDF')).toBeNull();
  expect(await artifacts.find(kysely, s.tenant, document, 'XML_AUTHORIZED')).toBeNull();
});

it('foreignDocumentIsNotFound', async () => {
  await pipeline.advance(s.tenant, document);
  const other = (await newOwner(testApp.http)).tenant;

  await expect(archiver.archive(other, document)).rejects.toMatchObject({ status: 404, errorCode: 'NOT_FOUND' });
  expect(await artifacts.find(kysely, s.tenant, document, 'RIDE_PDF')).toBeNull();
});

it('authorizationLeavesAnEventAndASafetyNet', async () => {
  await pipeline.advance(s.tenant, document);

  expect(await authorizedEvents()).toBe(1);
  // Si ese evento se pierde, el comprobante se retoma al vencer este plazo y lo vuelve a emitir.
  expect(minutes(await nextAttemptAt())).toBeGreaterThan(4);
  expect(minutes(await nextAttemptAt())).toBeLessThan(6);
  await db.query('UPDATE fiscal_documents SET next_attempt_at = now() WHERE id = $1', [document]);

  expect(await pipeline.advance(s.tenant, document)).toBe('AUTHORIZED');
  expect(await authorizedEvents()).toBe(2);
  expect(minutes(await nextAttemptAt())).toBeGreaterThan(4);

  await archiver.archive(s.tenant, document);
  await db.query('UPDATE fiscal_documents SET next_attempt_at = now() WHERE id = $1', [document]);

  // Ya archivado: nada más que hacer y nada más programado.
  expect(await pipeline.advance(s.tenant, document)).toBe('AUTHORIZED');
  expect(await authorizedEvents()).toBe(2);
  expect(await nextAttemptAt()).toBeNull();
});

it('artifactsAreDownloadableWithTheirContentType', async () => {
  const get = (kind: string, token = s.owner) =>
    testApp.http
      .get(`/api/v1/documents/${document}/artifacts/${kind}`)
      .set('Authorization', bearer(token))
      .buffer(true)
      .responseType('blob');
  await pipeline.advance(s.tenant, document);
  expect((await get('ride')).status).toBe(404);
  expect((await get('xml-authorized')).status).toBe(404);

  await archiver.archive(s.tenant, document);

  const sequence = (
    await db.query<{ n: string }>("SELECT lpad(sequence::text, 9, '0') AS n FROM fiscal_documents WHERE id = $1", [
      document,
    ])
  ).rows[0]!.n;
  const ride = await get('ride');
  expect(ride.status).toBe(200);
  expect(ride.headers['content-type']).toBe('application/pdf');
  expect(ride.headers.etag).toBeTruthy();
  // Se descarga con el número del comprobante, no se abre dentro del sitio.
  expect(ride.headers['content-disposition']).toBe(`attachment; filename="factura-001-001-${sequence}-ride.pdf"`);
  expect(ride.headers['x-content-type-options']).toBe('nosniff');
  expect((ride.body as Buffer).equals((await artifact('RIDE_PDF')).content)).toBe(true);
  const xml = await get('xml-authorized');
  expect(xml.status).toBe(200);
  expect(xml.headers['content-type']).toBe('application/xml');
  expect(xml.headers['content-disposition']).toBe(
    `attachment; filename="factura-001-001-${sequence}-xml-authorized.xml"`,
  );
  expect((xml.body as Buffer).equals((await artifact('XML_AUTHORIZED')).content)).toBe(true);

  const other = await billingScenario(testApp.http, db);
  expect((await get('ride', other.owner)).status).toBe(404);
});
