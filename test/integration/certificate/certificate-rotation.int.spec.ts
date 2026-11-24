import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { XadesVerifier } from '../../../src/signature/xades-verifier.js';
import { ArtifactStore } from '../../../src/storage/artifact-store.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  billingScenario,
  invoiceJson,
  issueInvoice,
  processDocument,
  uploadTestCertificate,
  type BillingScenario,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de certificate/CertificateRotationIT.java: renovar el certificado de un emisor. Lo nuevo se firma
// con el nuevo, y lo ya firmado con el anterior sigue siendo verificable y nadie lo vuelve a firmar.
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let kysely: Kysely<DB>;
const verifier = new XadesVerifier();

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  kysely = testApp.app.get(DATABASE);
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});

async function signedXml(s: BillingScenario, document: string): Promise<Buffer> {
  return (await testApp.app.get(ArtifactStore).find(kysely, s.tenant, document, 'XML_SIGNED'))!.content;
}

/** Huella SHA-256 del certificado con el que se firmó el XML. */
function signerFingerprint(xml: Buffer): string {
  const match = /X509Certificate>([^<]+)</.exec(xml.toString('utf8'));
  expect(match).not.toBeNull();
  return createHash('sha256').update(Buffer.from(match![1]!.replace(/\s/g, ''), 'base64')).digest('hex');
}

async function fingerprintWithStatus(s: BillingScenario, status: string): Promise<string> {
  const rows = await db.query<{ fingerprint_sha256: string }>(
    'SELECT fingerprint_sha256 FROM certificates WHERE taxpayer_id = $1 AND status = $2',
    [s.taxpayer, status],
  );
  expect(rows.rows).toHaveLength(1);
  return rows.rows[0]!.fingerprint_sha256;
}

it('aRenewedCertificateSignsWhatComesNextAndLeavesTheRestAlone', async () => {
  const s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  const before = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));
  expect(await processDocument(testApp.app, s.tenant, before)).toBe('SIGNED');
  const signedBefore = await signedXml(s, before);

  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer, 'anotherValid');
  const after = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'));
  expect(await processDocument(testApp.app, s.tenant, after)).toBe('SIGNED');

  const previous = await fingerprintWithStatus(s, 'REPLACED');
  const current = await fingerprintWithStatus(s, 'ACTIVE');
  expect(previous.toLowerCase()).not.toBe(current.toLowerCase());
  expect(signerFingerprint(await signedXml(s, after))).toBe(current.toLowerCase());

  // Lo firmado antes de la renovación no cambia ni se vuelve a firmar, y sigue verificando.
  expect(await processDocument(testApp.app, s.tenant, before)).toBe('SIGNED');
  expect((await signedXml(s, before)).equals(signedBefore)).toBe(true);
  expect(signerFingerprint(signedBefore)).toBe(previous.toLowerCase());
  expect(verifier.verify(signedBefore).errors).toEqual([]);
  expect(verifier.verify(await signedXml(s, after)).errors).toEqual([]);
});
