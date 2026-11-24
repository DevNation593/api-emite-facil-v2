import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import type { Response, Test } from 'supertest';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import type { ArtifactKind } from '../../../src/storage/artifact-kind.js';
import { ArtifactStore } from '../../../src/storage/artifact-store.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  bearer,
  billingScenario,
  invoiceJson,
  issueInvoice,
  memberToken,
  type BillingScenario,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de storage/ArtifactStoreIT.java (la descarga; el almacén, en artifact-store.int.spec.ts). Las
// cabeceras y las peticiones condicionales las fija además el sondeo de Java (java-probes.int.spec.ts).
const XML = Buffer.from('<factura id="comprobante">ñ</factura>', 'utf8');

let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let kysely: Kysely<DB>;
let artifacts: ArtifactStore;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  kysely = testApp.app.get(DATABASE);
  artifacts = testApp.app.get(ArtifactStore);
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});

let s: BillingScenario;
let document: string;
beforeEach(async () => {
  s = await billingScenario(testApp.http, db);
  document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'));
});

const save = (kind: ArtifactKind, content: Buffer) =>
  kysely.transaction().execute((trx) => artifacts.save(trx, s.tenant, document, kind, content));

const download = (token: string, kind: string, id: string = document): Test =>
  testApp.http.get(`/api/v1/documents/${id}/artifacts/${kind}`).set('Authorization', bearer(token)).buffer(true).parse(bytes);

/** El cuerpo tal como llega, sin interpretarlo. */
function bytes(res: Response, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  const stream = res as unknown as NodeJS.ReadableStream;
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

const problem = (res: Response) => JSON.parse((res.body as Buffer).toString('utf8')) as Record<string, unknown>;

it('artifactOfAnotherTenantIsNotFound', async () => {
  await save('XML_SIGNED', XML);
  const other = await billingScenario(testApp.http, db);

  expect(await artifacts.find(kysely, other.tenant, document, 'XML_SIGNED')).toBeNull();
  expect(await artifacts.findForDownload(kysely, other.tenant, document, 'XML_SIGNED')).toBeNull();
  const res = await download(other.owner, 'xml-signed');
  expect(res.status).toBe(404);
  expect(problem(res)).toMatchObject({ errorCode: 'NOT_FOUND' });
});

it('downloadReturnsXmlWithEtag', async () => {
  const sha = await save('XML_SIGNED', XML);

  const res = await download(await memberToken(testApp.http, db, s.tenant, 'AUDITOR'), 'xml-signed');

  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('application/xml');
  expect(res.headers.etag).toBe(`"${sha}"`);
  expect(sha).toBe(createHash('sha256').update(XML).digest('hex'));
  expect(res.headers['content-length']).toBe(String(XML.length));
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect((res.body as Buffer).equals(XML)).toBe(true);
});

it('un PDF llega byte a byte, aunque no sea texto', async () => {
  const pdf = Buffer.from(Array.from({ length: 2_000 }, (_, i) => (i * 7) % 256));
  await save('RIDE_PDF', pdf);

  const res = await download(s.owner, 'ride');

  expect(res.headers['content-type']).toBe('application/pdf');
  expect(res.headers['content-disposition']).toMatch(/^attachment; filename="factura-001-001-\d{9}-ride\.pdf"$/);
  expect((res.body as Buffer).equals(pdf)).toBe(true);
});

it('unknownKindIsBadRequest', async () => {
  const res = await download(s.owner, 'pdf');
  expect(res.status).toBe(400);
  expect(problem(res)).toMatchObject({ errorCode: 'MALFORMED_REQUEST', detail: 'Tipo de artefacto desconocido' });
});

it('missingArtifactIsNotFound', async () => {
  expect((await download(s.owner, 'xml-signed')).status).toBe(404);
  expect((await download(s.owner, 'xml-signed', randomUUID())).status).toBe(404);
});

it('con If-None-Match igual responde 304 sin cuerpo ni cabeceras que impidan guardarla', async () => {
  const sha = await save('XML_SIGNED', XML);

  const res = await download(s.owner, 'xml-signed').set('If-None-Match', `"otro", W/"${sha}"`);

  expect(res.status).toBe(304);
  expect((res.body as Buffer).length).toBe(0);
  expect(res.headers.etag).toBe(`"${sha}"`);
  expect(res.headers['cache-control']).toBeUndefined();
  expect(res.headers['x-content-type-options']).toBe('nosniff');
});
