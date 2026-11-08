import { randomUUID, sign, verify } from 'node:crypto';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { CertificateService } from '../../../src/certificate/certificate.service.js';
import { CertificateRejectedException, inspectPkcs12 } from '../../../src/certificate/pkcs12-inspector.js';
import { SecretCipherException } from '../../../src/certificate/secret-cipher.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { bearer, createTaxpayer, memberToken, newOwner } from '../../support/scenario.js';
import { TEST_P12_PASSWORD, testP12 } from '../../support/test-certificates.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de CertificateApiIT. CertificateRotationIT llega en E4: necesita firmar.
const CERTIFICATES = '/api/v1/certificates';
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let certificates: CertificateService;
let owner: string;
let tenant: string;
let taxpayer: string;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  certificates = testApp.app.get(CertificateService);
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});
beforeEach(async () => {
  ({ token: owner, tenant } = await newOwner(testApp.http));
  taxpayer = await createTaxpayer(testApp.http, owner);
});

const http = () => testApp.http;
const body = (taxpayerId: string, p12: Buffer, password: string) => ({
  taxpayerId,
  p12: p12.toString('base64'),
  password,
});
const upload = (token: string, payload: unknown) =>
  http().post(CERTIFICATES).set('Authorization', bearer(token)).send(payload as object);
const list = (token: string, taxpayerId: string) =>
  http().get(CERTIFICATES).query({ taxpayerId }).set('Authorization', bearer(token));
const stored = async () =>
  Number((await db.query('SELECT count(*) AS n FROM certificates WHERE taxpayer_id = $1', [taxpayer])).rows[0].n);
const rejection = async (run: () => Promise<unknown>) => run().then(() => null, (e: unknown) => e);

it('el propietario carga un certificado', async () => {
  const res = await upload(owner, body(taxpayer, testP12('valid'), TEST_P12_PASSWORD)).expect(201);
  expect(res.body).toEqual({
    id: expect.any(String),
    taxpayerId: taxpayer,
    subject: 'CN=Emisor de Pruebas firma,O=Pruebas,C=EC',
    issuer: 'CN=Emisor de Pruebas firma,O=Pruebas,C=EC',
    serialNumber: expect.stringMatching(/^[0-9]+$/),
    fingerprintSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    validFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    validTo: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    status: 'ACTIVE',
  });
  expect(Object.keys(res.body)).toEqual([
    'id',
    'taxpayerId',
    'subject',
    'issuer',
    'serialNumber',
    'fingerprintSha256',
    'validFrom',
    'validTo',
    'status',
  ]);
  const id = (res.body as { id: string }).id;
  const listed = await list(await memberToken(http(), db, tenant, 'AUDITOR'), taxpayer).expect(200);
  expect(listed.body).toEqual([res.body]);
  const audit = await db.query(
    "SELECT metadata FROM audit_events WHERE action = 'CERTIFICATE_UPLOADED' AND entity_id = $1 AND tenant_id = $2",
    [id, tenant],
  );
  expect(audit.rows).toEqual([
    {
      metadata: {
        taxpayerId: taxpayer,
        fingerprintSha256: res.body.fingerprintSha256,
        validTo: (res.body.validTo as string).replace(/:00Z$/, 'Z'),
      },
    },
  ]);
});

it('el facturador no carga certificados', async () => {
  const res = await upload(
    await memberToken(http(), db, tenant, 'BILLER'),
    body(taxpayer, testP12('valid'), TEST_P12_PASSWORD),
  ).expect(403);
  expect(res.body.errorCode).toBe('ROLE_FORBIDDEN');
  expect(await stored()).toBe(0);
});

it('una segunda carga reemplaza a la primera', async () => {
  await upload(owner, body(taxpayer, testP12('valid'), TEST_P12_PASSWORD)).expect(201);
  await upload(owner, body(taxpayer, testP12('anotherValid'), TEST_P12_PASSWORD)).expect(201);
  const statuses = await db.query('SELECT status FROM certificates WHERE taxpayer_id = $1 ORDER BY created_at', [
    taxpayer,
  ]);
  expect(statuses.rows.map((r) => r.status)).toEqual(['REPLACED', 'ACTIVE']);
  const material = await certificates.signingMaterial(tenant, taxpayer, new Date());
  const second = await inspectPkcs12(testP12('anotherValid'), TEST_P12_PASSWORD, new Date());
  expect(material.certificateDer.equals(second.certificateDer)).toBe(true);
});

it('los certificados rechazados no dejan nada', async () => {
  const cases: Array<[Buffer, string, string]> = [
    [testP12('valid'), 'otra-clave', 'CERTIFICATE_UNREADABLE'],
    [Buffer.from('no es un p12'), TEST_P12_PASSWORD, 'CERTIFICATE_UNREADABLE'],
    [testP12('expired'), TEST_P12_PASSWORD, 'CERTIFICATE_EXPIRED'],
    [testP12('notYetValid'), TEST_P12_PASSWORD, 'CERTIFICATE_NOT_YET_VALID'],
    [testP12('withoutPrivateKey'), TEST_P12_PASSWORD, 'CERTIFICATE_NO_PRIVATE_KEY'],
    [testP12('twoSigningKeys'), TEST_P12_PASSWORD, 'CERTIFICATE_AMBIGUOUS'],
    [testP12('shortKey'), TEST_P12_PASSWORD, 'CERTIFICATE_KEY_UNSUPPORTED'],
    [testP12('mismatchedKey'), TEST_P12_PASSWORD, 'CERTIFICATE_KEY_MISMATCH'],
  ];
  for (const [p12, password, errorCode] of cases) {
    const res = await upload(owner, body(taxpayer, p12, password)).expect(422);
    expect(res.body.errorCode, errorCode).toBe(errorCode);
  }
  expect(await stored()).toBe(0);
});

it('rechaza peticiones mal formadas', async () => {
  const valid = body(taxpayer, testP12('valid'), TEST_P12_PASSWORD);
  const base64 = await upload(owner, { ...valid, p12: '###no-base64###' }).expect(400);
  expect(base64.body).toMatchObject({ errorCode: 'MALFORMED_REQUEST', detail: 'El campo p12 debe venir en Base64' });
  const large = await upload(owner, body(taxpayer, Buffer.alloc(70_000), TEST_P12_PASSWORD)).expect(400);
  expect(large.body.errorCode).toBe('VALIDATION_FAILED');
  await upload(owner, body(taxpayer, testP12('valid'), '')).expect(400);
  await http().get(CERTIFICATES).set('Authorization', bearer(owner)).expect(400);
  expect(await stored()).toBe(0);
});

it('el secreto nunca sale del servidor', async () => {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
    }),
  );
  const p12 = testP12('valid');
  const marker = p12.toString('base64').slice(0, 40);
  try {
    const response = await upload(owner, body(taxpayer, p12, TEST_P12_PASSWORD)).expect(201);
    const wrong = await upload(owner, body(taxpayer, p12, 'clave-equivocada-xyz')).expect(422);
    expect(wrong.text).not.toContain('clave-equivocada-xyz');
    const listed = await list(owner, taxpayer);
    for (const text of [response.text, listed.text, lines.join('\n')]) {
      expect(text).not.toContain(TEST_P12_PASSWORD);
      expect(text).not.toContain(marker);
      expect(text).not.toContain('clave-equivocada-xyz');
    }
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
  const audit = await db.query("SELECT string_agg(metadata::text, ' ') AS m FROM audit_events WHERE tenant_id = $1", [
    tenant,
  ]);
  expect(audit.rows[0].m).not.toContain(TEST_P12_PASSWORD);
  expect(audit.rows[0].m).not.toContain(marker);
  const row = (
    await db.query(
      "SELECT encrypted_p12, encrypted_password FROM certificates WHERE taxpayer_id = $1 AND status = 'ACTIVE'",
      [taxpayer],
    )
  ).rows[0] as { encrypted_p12: Buffer; encrypted_password: Buffer };
  expect(row.encrypted_p12.equals(p12)).toBe(false);
  expect(row.encrypted_p12.toString('latin1')).not.toContain(p12.toString('latin1').slice(0, 64));
  expect(row.encrypted_password.toString('latin1')).not.toContain(TEST_P12_PASSWORD);
});

it('el certificado de otra empresa no existe', async () => {
  await upload(owner, body(taxpayer, testP12('valid'), TEST_P12_PASSWORD)).expect(201);
  const other = await newOwner(http());
  await upload(other.token, body(taxpayer, testP12('valid'), TEST_P12_PASSWORD)).expect(404);
  await list(other.token, taxpayer).expect(404);
  expect(await rejection(() => certificates.signingMaterial(other.tenant, taxpayer, new Date()))).toMatchObject({
    errorCode: 'CERTIFICATE_MISSING',
    message: 'El emisor no tiene un certificado de firma activo',
  });
  expect(await stored()).toBe(1);
});

it('un certificado malo no reemplaza a uno que funciona', async () => {
  await upload(owner, body(taxpayer, testP12('valid'), TEST_P12_PASSWORD)).expect(201);
  await upload(owner, body(taxpayer, testP12('mismatchedKey'), TEST_P12_PASSWORD)).expect(422);
  const statuses = await db.query('SELECT status FROM certificates WHERE taxpayer_id = $1', [taxpayer]);
  expect(statuses.rows.map((r) => r.status)).toEqual(['ACTIVE']);
  expect(await certificates.signingMaterial(tenant, taxpayer, new Date())).toBeDefined();
});

it('el cifrado queda ligado a su emisor y a su campo', async () => {
  await upload(owner, body(taxpayer, testP12('valid'), TEST_P12_PASSWORD)).expect(201);
  const swap = () =>
    db.query(
      'UPDATE certificates SET encrypted_p12 = encrypted_password, encrypted_password = encrypted_p12 WHERE taxpayer_id = $1',
      [taxpayer],
    );
  await swap();
  expect(await rejection(() => certificates.signingMaterial(tenant, taxpayer, new Date()))).toBeInstanceOf(
    SecretCipherException,
  );
  await swap();
  expect(await certificates.signingMaterial(tenant, taxpayer, new Date())).toBeDefined();
  const other = await newOwner(http());
  const otherTaxpayer = await createTaxpayer(http(), other.token);
  await db.query('UPDATE certificates SET tenant_id = $1, taxpayer_id = $2 WHERE taxpayer_id = $3', [
    other.tenant,
    otherTaxpayer,
    taxpayer,
  ]);
  expect(await rejection(() => certificates.signingMaterial(other.tenant, otherTaxpayer, new Date()))).toBeInstanceOf(
    SecretCipherException,
  );
});

it('el material de firma se recupera y firma', async () => {
  const missing = await rejection(() => certificates.signingMaterial(tenant, taxpayer, new Date()));
  expect(missing).toBeInstanceOf(CertificateRejectedException);
  expect(missing).toMatchObject({ errorCode: 'CERTIFICATE_MISSING' });
  await upload(owner, body(taxpayer, testP12('valid'), TEST_P12_PASSWORD)).expect(201);
  const material = await certificates.signingMaterial(tenant, taxpayer, new Date());
  const message = Buffer.from('comprobante');
  const signature = sign('sha256', message, material.privateKey);
  expect(verify('sha256', message, material.certificate.publicKey, signature)).toBe(true);
  const later = new Date(Date.now() + 550 * 24 * 3600 * 1000);
  expect(await rejection(() => certificates.signingMaterial(tenant, taxpayer, later))).toMatchObject({
    errorCode: 'CERTIFICATE_EXPIRED',
  });
});

it('el p12 se decodifica con las reglas del decodificador de Java', async () => {
  // Sin relleno vale (y el contenido no es un PKCS#12); con espacios, saltos o Base64 URL, no.
  expect((await upload(owner, { taxpayerId: taxpayer, p12: 'QUI', password: 'x' }).expect(422)).body.errorCode).toBe(
    'CERTIFICATE_UNREADABLE',
  );
  for (const p12 of ['QUJD\nREVG', ' QUJD', 'Pz8-Pz8_', 'QQ===', 'QUJDR', 'Q']) {
    const res = await upload(owner, { taxpayerId: taxpayer, p12, password: 'x' }).expect(400);
    expect(res.body.detail).toBe('El campo p12 debe venir en Base64');
  }
  await upload(owner, { taxpayerId: randomUUID(), p12: 'QUJD', password: 'x' }).expect(404);
});
