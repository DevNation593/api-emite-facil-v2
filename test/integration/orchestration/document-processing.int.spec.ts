import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { ApiException } from '../../../src/common/api-exception.js';
import { secretContext } from '../../../src/certificate/certificate.service.js';
import { SECRET_CIPHER, type AesGcmSecretCipher } from '../../../src/certificate/secret-cipher.js';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { XadesVerifier } from '../../../src/signature/xades-verifier.js';
import { ArtifactStore } from '../../../src/storage/artifact-store.js';
import { DOCUMENT_SCHEMAS } from '../../../src/xml/document-type.js';
import { checkEnvelope } from '../../../src/xml/envelope-rules.js';
import { XsdValidator } from '../../../src/xml/xsd-validator.js';
import { insertDocument } from '../../support/billing-data.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  billingScenario,
  invoiceJson,
  issueInvoice,
  processDocument,
  uploadTestCertificate,
  type BillingScenario,
} from '../../support/scenario.js';
import { TEST_P12_PASSWORD, testP12 } from '../../support/test-certificates.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de orchestration/DocumentProcessingIT.java. La descarga de signedXmlIsDownloadableAndStateIsVisible
// llega en E5: aquí el estado y el artefacto se comprueban por SQL.
const PROVIDER_RUC = '1790099999001';
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let kysely: Kysely<DB>;
let artifacts: ArtifactStore;
const verifier = new XadesVerifier();

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack, { EINVOICE_PROVIDER_RUC: PROVIDER_RUC });
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
  document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));
});

const http = () => testApp.http;
const process = (tenant: string, id: string) => processDocument(testApp.app, tenant, id);
const state = async () =>
  (await db.query<{ state: string }>('SELECT state FROM fiscal_documents WHERE id = $1', [document])).rows[0]!.state;
const transitions = async (id = document) =>
  (
    await db.query<{ t: string }>(
      "SELECT coalesce(previous_state, '-') || '>' || new_state AS t FROM state_events WHERE document_id = $1 ORDER BY event_time",
      [id],
    )
  ).rows.map((r) => r.t);
const artifactCount = async () =>
  Number(
    (await db.query<{ n: string }>('SELECT count(*) AS n FROM document_artifacts WHERE document_id = $1', [document]))
      .rows[0]!.n,
  );
const reasons = async (newState: string) =>
  (
    await db.query<{ reason: string }>(
      'SELECT reason FROM state_events WHERE document_id = $1 AND new_state = $2 ORDER BY event_time',
      [document, newState],
    )
  ).rows.map((r) => r.reason);
const find = (kind: 'XML_UNSIGNED' | 'XML_SIGNED', id = document) => artifacts.find(kysely, s.tenant, id, kind);

it('reservedInvoiceBecomesSigned', async () => {
  await uploadTestCertificate(http(), s.owner, s.taxpayer);

  expect(await process(s.tenant, document)).toBe('SIGNED');

  expect(await state()).toBe('SIGNED');
  const version = await db.query('SELECT schema_version FROM fiscal_documents WHERE id = $1', [document]);
  expect(version.rows[0]).toEqual({ schema_version: '1.1.0' });
  expect(await transitions()).toEqual(['->RESERVED', 'RESERVED>GENERATED', 'GENERATED>SIGNED']);
  expect(await artifactCount()).toBe(2);

  const signed = (await find('XML_SIGNED'))!.content;
  expect(verifier.verify(signed).errors).toEqual([]);
  expect((await new XsdValidator().validate(signed, DOCUMENT_SCHEMAS.INVOICE_1_1_0)).errors).toEqual([]);
  expect(checkEnvelope(signed, DOCUMENT_SCHEMAS.INVOICE_1_1_0).size).toBe(0);
  const accessKey = (await db.query('SELECT access_key FROM fiscal_documents WHERE id = $1', [document])).rows[0]
    .access_key as string;
  const xml = signed.toString('utf8');
  expect(xml).toContain(`<claveAcceso>${accessKey}</claveAcceso>`);
  expect(xml).toContain(`<ruc>${s.ruc}</ruc>`);
  expect(xml).toContain('<importeTotal>23.00</importeTotal>');
  expect(xml).toContain(`<campoAdicional nombre="RUC Proveedor">${PROVIDER_RUC}</campoAdicional>`);
  expect((await find('XML_UNSIGNED'))!.content.toString('utf8')).not.toContain('Signature');
});

it('signedXmlIsDownloadableAndStateIsVisible (estado y artefacto; la descarga llega en E5)', async () => {
  await uploadTestCertificate(http(), s.owner, s.taxpayer);
  await process(s.tenant, document);
  expect(verifier.verify((await find('XML_SIGNED'))!.content).valid).toBe(true);
  const res = await http().get(`/api/v1/documents/${document}`).set('Authorization', `Bearer ${s.owner}`).expect(200);
  expect((res.body as { state: string }).state).toBe('SIGNED');
});

it('processingTwiceChangesNothing', async () => {
  await uploadTestCertificate(http(), s.owner, s.taxpayer);
  await process(s.tenant, document);
  const sha = (await find('XML_SIGNED'))!.sha256;

  expect(await process(s.tenant, document)).toBe('SIGNED');

  expect((await find('XML_SIGNED'))!.sha256).toBe(sha);
  expect(await transitions()).toHaveLength(3);
  expect(await artifactCount()).toBe(2);
});

it('concurrentProcessingProducesOneSignedArtifact', async () => {
  await uploadTestCertificate(http(), s.owner, s.taxpayer);

  const results = await Promise.all(Array.from({ length: 5 }, () => process(s.tenant, document)));

  expect(results).toEqual(Array(5).fill('SIGNED'));
  expect(await artifactCount()).toBe(2);
  expect(await transitions()).toEqual(['->RESERVED', 'RESERVED>GENERATED', 'GENERATED>SIGNED']);
});

it('withoutCertificateEndsInSignatureFailedAndCanBeRetried', async () => {
  expect(await process(s.tenant, document)).toBe('SIGNATURE_FAILED');
  expect(await state()).toBe('SIGNATURE_FAILED');
  expect(await reasons('SIGNATURE_FAILED')).toEqual(['CERTIFICATE_MISSING']);
  expect(await find('XML_UNSIGNED')).not.toBeNull();
  expect(await find('XML_SIGNED')).toBeNull();

  // Reintentar sin haber arreglado nada no añade eventos.
  expect(await process(s.tenant, document)).toBe('SIGNATURE_FAILED');
  expect(await transitions()).toHaveLength(3);

  await uploadTestCertificate(http(), s.owner, s.taxpayer);
  expect(await process(s.tenant, document)).toBe('SIGNED');
  expect(await transitions()).toEqual([
    '->RESERVED',
    'RESERVED>GENERATED',
    'GENERATED>SIGNATURE_FAILED',
    'SIGNATURE_FAILED>SIGNED',
  ]);
  expect(await artifactCount()).toBe(2);
});

/** Un certificado que caducó después de cargarse: se inserta ya cifrado, saltando la validación de la carga. */
async function insertExpiredCertificate(): Promise<void> {
  const cipher = testApp.app.get<AesGcmSecretCipher>(SECRET_CIPHER);
  const certificateId = randomUUID();
  const user = (await db.query('SELECT created_by FROM fiscal_documents WHERE id = $1', [document])).rows[0]
    .created_by as string;
  await db.query(
    `INSERT INTO certificates (id, tenant_id, taxpayer_id, subject, issuer, serial_number,
      fingerprint_sha256, valid_from, valid_to, status, encrypted_p12, encrypted_password, created_by)
     VALUES ($1, $2, $3, 'CN=Caducado', 'CN=Caducado', '1', $4, now() - interval '30 days',
      now() - interval '25 days', 'ACTIVE', $5, $6, $7)`,
    [
      certificateId,
      s.tenant,
      s.taxpayer,
      'a'.repeat(64),
      cipher.encrypt(testP12('expired'), secretContext(s.tenant, s.taxpayer, certificateId, 'p12')),
      cipher.encrypt(
        Buffer.from(TEST_P12_PASSWORD, 'utf8'),
        secretContext(s.tenant, s.taxpayer, certificateId, 'password'),
      ),
      user,
    ],
  );
}

it('expiredCertificateEndsInSignatureFailed', async () => {
  await insertExpiredCertificate();

  expect(await process(s.tenant, document)).toBe('SIGNATURE_FAILED');
  expect((await reasons('SIGNATURE_FAILED')).at(-1)).toBe('CERTIFICATE_EXPIRED');
  expect(await find('XML_SIGNED')).toBeNull();
});

it('undecryptableCertificateEndsInSignatureFailedKeepingTheGeneratedXml', async () => {
  await uploadTestCertificate(http(), s.owner, s.taxpayer);
  // Certificado guardado que ya no se puede descifrar (blob dañado o clave maestra cambiada).
  await db.query(
    'UPDATE certificates SET encrypted_p12 = set_byte(encrypted_p12, 40, get_byte(encrypted_p12, 40) # 1) WHERE taxpayer_id = $1',
    [s.taxpayer],
  );

  expect(await process(s.tenant, document)).toBe('SIGNATURE_FAILED');

  expect(await state()).toBe('SIGNATURE_FAILED');
  expect(await transitions()).toEqual(['->RESERVED', 'RESERVED>GENERATED', 'GENERATED>SIGNATURE_FAILED']);
  expect(await reasons('SIGNATURE_FAILED')).toEqual(['CERTIFICATE_UNDECRYPTABLE']);
  expect(await find('XML_UNSIGNED')).not.toBeNull();

  await uploadTestCertificate(http(), s.owner, s.taxpayer, 'anotherValid');
  expect(await process(s.tenant, document)).toBe('SIGNED');
});

it('una firma fallida por certificado indescifrable no deja en los logs la clave, la contraseña ni el .p12', async () => {
  const lines: string[] = [];
  const spies = (['log', 'error', 'warn', 'debug', 'verbose'] as const).map((level) =>
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(
        args
          .map((a) => (a instanceof Error ? `${a.stack} ${JSON.stringify(a)} ${String(a.cause)}` : String(a)))
          .join(' '),
      );
    }),
  );
  try {
    await uploadTestCertificate(http(), s.owner, s.taxpayer);
    await db.query(
      'UPDATE certificates SET encrypted_p12 = set_byte(encrypted_p12, 40, get_byte(encrypted_p12, 40) # 1) WHERE taxpayer_id = $1',
      [s.taxpayer],
    );
    expect(await process(s.tenant, document)).toBe('SIGNATURE_FAILED');
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  const dump = lines.join('\n');
  expect(dump).toContain('no se pudo descifrar');
  expect(dump).not.toContain(TEST_P12_PASSWORD);
  expect(dump).not.toContain(testP12('valid').toString('base64').slice(0, 40));
  expect(dump).not.toMatch(/PRIVATE KEY/);
});

it('retryThatFailsForAnotherReasonRecordsIt', async () => {
  expect(await process(s.tenant, document)).toBe('SIGNATURE_FAILED');
  await insertExpiredCertificate();
  expect(await process(s.tenant, document)).toBe('SIGNATURE_FAILED');

  expect(await reasons('SIGNATURE_FAILED')).toEqual(['CERTIFICATE_MISSING', 'CERTIFICATE_EXPIRED']);
  // El mismo fallo repetido no añade más eventos.
  await process(s.tenant, document);
  expect(await transitions()).toHaveLength(4);
});

it('signerFailureEndsInSignatureFailedInsteadOfLosingTheAttempt', async () => {
  expect(await process(s.tenant, document)).toBe('SIGNATURE_FAILED');
  await uploadTestCertificate(http(), s.owner, s.taxpayer);
  // El XML generado se dañó en el almacenamiento: el firmador no puede leerlo. La base no deja modificar un
  // artefacto: para simular el daño hay que retirar antes su protección.
  await db.query('ALTER TABLE document_artifacts DISABLE TRIGGER document_artifacts_immutable');
  try {
    await db.query('UPDATE document_artifacts SET content = $1 WHERE document_id = $2', [
      Buffer.from('esto no es un XML'),
      document,
    ]);
  } finally {
    await db.query('ALTER TABLE document_artifacts ENABLE TRIGGER document_artifacts_immutable');
  }

  expect(await process(s.tenant, document)).toBe('SIGNATURE_FAILED');

  expect(await reasons('SIGNATURE_FAILED')).toEqual(['CERTIFICATE_MISSING', 'SIGNING_ERROR']);
  expect(await find('XML_SIGNED')).toBeNull();
});

it('documentOfAnotherTenantIsNotFound', async () => {
  const other = await billingScenario(http(), db);
  await expect(process(other.tenant, document)).rejects.toBeInstanceOf(ApiException);
  await expect(process(s.tenant, randomUUID())).rejects.toBeInstanceOf(ApiException);
  expect(await state()).toBe('RESERVED');
  expect(await artifactCount()).toBe(0);
});

it('invalidXmlEndsInXsdInvalid', async () => {
  await uploadTestCertificate(http(), s.owner, s.taxpayer);
  await db.query("UPDATE fiscal_documents SET issuer_legal_name = repeat('x', 301) WHERE id = $1", [document]);

  expect(await process(s.tenant, document)).toBe('XSD_INVALID');

  expect(await state()).toBe('XSD_INVALID');
  expect((await reasons('XSD_INVALID'))[0]).toContain('razonSocial');
  expect(await artifactCount()).toBe(0);
  // No se reintenta solo: el documento necesita corrección.
  expect(await process(s.tenant, document)).toBe('XSD_INVALID');
  expect(await transitions()).toHaveLength(2);
});

it('el motivo se recorta a 500 caracteres', async () => {
  await db.query("UPDATE fiscal_documents SET issuer_legal_name = repeat('x', 3000) WHERE id = $1", [document]);
  expect(await process(s.tenant, document)).toBe('XSD_INVALID');
  expect((await reasons('XSD_INVALID'))[0]!.length).toBeLessThanOrEqual(500);
});

/** TestData.document: un comprobante de otro tipo por SQL, con su contenido JSON. */
async function otherDocument(type: string, contentJson: string): Promise<string> {
  const user = (await db.query('SELECT created_by FROM fiscal_documents WHERE id = $1', [document])).rows[0]
    .created_by as string;
  return insertDocument(
    db,
    { tenant: s.tenant, taxpayer: s.taxpayer, point: s.point, customer: s.customer, user },
    50,
    { type, content: contentJson },
  );
}

const lastReason = async (id: string) =>
  (
    await db.query<{ reason: string }>(
      'SELECT reason FROM state_events WHERE document_id = $1 ORDER BY event_time DESC LIMIT 1',
      [id],
    )
  ).rows[0]!.reason;

it('unsupportedTypeEndsInXsdInvalid', async () => {
  const retention = await otherDocument('07', '{}');
  expect(await process(s.tenant, retention)).toBe('XSD_INVALID');
  expect(await lastReason(retention)).toBe('DOCUMENT_TYPE_NOT_SUPPORTED');
});

it('unreadableContentEndsInXsdInvalid', async () => {
  const debit = await otherDocument('05', '[]');
  expect(await process(s.tenant, debit)).toBe('XSD_INVALID');
  expect(await lastReason(debit)).toBe('CONTENT_UNREADABLE');
});

it('un dato que el XML no admite termina en XSD_INVALID con su mensaje', async () => {
  await uploadTestCertificate(http(), s.owner, s.taxpayer);
  await db.query("UPDATE fiscal_documents SET customer_name = 'Juan' || chr(1) || 'Pérez' WHERE id = $1", [document]);
  expect(await process(s.tenant, document)).toBe('XSD_INVALID');
  expect((await reasons('XSD_INVALID'))[0]).toMatch(/carácter/i);
  expect(await transitions()).toEqual(['->RESERVED', 'RESERVED>XSD_INVALID']);
});
