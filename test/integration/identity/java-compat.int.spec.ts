import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type PostgresHandle,
  type RedisHandle,
  type RabbitHandle,
  runFlyway,
  startPostgres,
  startRabbit,
  startRedis,
} from '../../support/containers.js';
import { freshIp, startTestApp, type TestApp } from '../../support/test-app.js';
import { createHash, randomUUID } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import { CertificateService } from '../../../src/certificate/certificate.service.js';
import { BigDecimal } from '../../../src/common/big-decimal.js';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { DeliveryService } from '../../../src/delivery/delivery.service.js';
import { DocumentPipeline } from '../../../src/orchestration/document-pipeline.js';
import { XadesVerifier } from '../../../src/signature/xades-verifier.js';
import { ArtifactStore } from '../../../src/storage/artifact-store.js';
import { pdfText } from '../../support/pdf-inspect.js';
import { processDocument } from '../../support/scenario.js';
import { SriStub, sriTestEnv } from '../../support/sri-stub.js';

/**
 * Datos escritos por la API Java (tools/java-dump): una cuenta, su sesión, una empresa y una API key,
 * los datos de E2 y una factura autorizada con dos notas de crédito y una de débito (E3). NestJS los
 * lee sin que Java vuelva a correr. Si una prueba falla es una incompatibilidad real: se
 * corrige en NestJS, nunca en los fixtures.
 */
const fixtures = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'java-e1');

interface JavaMeta {
  email: string;
  password: string;
  userId: string;
  tenantId: string;
  tenantName: string;
  refreshToken: string;
  accessToken: string;
  accessTokenIat: number;
  accessTokenExp: number;
  apiKey: string;
  taxpayerId: string;
  certificateId: string;
  certificateFingerprint: string;
  customerId: string;
  productId: string;
  invoiceId: string;
  creditNoteId: string;
  manualCreditNoteId: string;
  debitNoteId: string;
  views: Record<'taxpayer' | 'establishment' | 'emissionPoint' | 'customer' | 'product' | 'certificate', Record<string, unknown>>;
  env: { EINVOICE_JWT_SECRET: string; EINVOICE_MASTER_KEY: string };
}

const meta = JSON.parse(readFileSync(path.join(fixtures, 'meta.json'), 'utf8')) as JavaMeta;

let postgres: PostgresHandle;
let rabbit: RabbitHandle;
let redis: RedisHandle;
let testApp: TestApp;
let sri: SriStub;

beforeAll(async () => {
  sri = await SriStub.start();
  [postgres, rabbit, redis] = await Promise.all([startPostgres(), startRabbit(), startRedis()]);
  // El volcado lleva órdenes de psql (COPY ... FROM stdin): se carga con psql dentro del contenedor.
  await postgres.container.copyFilesToContainer([
    { source: path.join(fixtures, 'dump.sql'), target: '/tmp/dump.sql' },
  ]);
  const load = await postgres.container.exec([
    'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'test', '-d', 'einvoice', '-f', '/tmp/dump.sql',
  ]);
  if (load.exitCode !== 0) throw new Error(`no se pudo cargar el volcado:\n${load.output}`);
  testApp = await startTestApp(
    { databaseUrl: postgres.databaseUrl, rabbitUrl: rabbit.rabbitUrl, redisUrl: redis.redisUrl },
    // El SRI simulado, para llevar por el pipeline de NestJS lo que emitió Java (E4).
    // El correo habilitado, hacia el SMTP en memoria (E5).
    { ...meta.env, ...sriTestEnv(sri), DELIVERY_EMAIL_ENABLED: 'true' },
  );
});
afterAll(async () => {
  await testApp?.close();
  await sri?.close();
  await Promise.allSettled([postgres?.stop(), rabbit?.stop(), redis?.stop()]);
});

const http = () => testApp.http;
const bearer = (token: string) => `Bearer ${token}`;

it('las migraciones de este repo validan contra el historial que dejó Java', async () => {
  const run = await runFlyway(postgres.internalUrl, postgres.network, 'validate');
  expect(run.exitCode, run.output).toBe(0);
});

it('un usuario creado por Java ingresa con su contraseña', async () => {
  const res = await http()
    .post('/api/v1/auth/login')
    .set('X-Forwarded-For', freshIp())
    .send({ email: meta.email, password: meta.password })
    .expect(200);
  const me = await http()
    .get('/api/v1/auth/me')
    .set('Authorization', bearer((res.body as { accessToken: string }).accessToken))
    .expect(200);
  expect(me.body).toEqual({ id: meta.userId, email: meta.email, emailVerified: false });
});

it('el correo que Java normalizó se encuentra escrito en mayúsculas', async () => {
  await http()
    .post('/api/v1/auth/login')
    .set('X-Forwarded-For', freshIp())
    .send({ email: meta.email.toUpperCase(), password: meta.password })
    .expect(200);
});

it('un token de renovación emitido por Java renueva la sesión', async () => {
  const res = await http()
    .post('/api/v1/auth/refresh')
    .set('X-Forwarded-For', freshIp())
    .send({ refreshToken: meta.refreshToken })
    .expect(200);
  const body = res.body as { accessToken: string; refreshToken: string };
  expect(body.refreshToken).not.toBe(meta.refreshToken);
  await http().get('/api/v1/auth/me').set('Authorization', bearer(body.accessToken)).expect(200);
});

it('la API key creada por Java autentica y conserva su empresa', async () => {
  const res = await http()
    .get('/api/v1/tenants/current')
    .set('X-Api-Key', meta.apiKey)
    .expect(200);
  expect(res.body).toEqual({
    id: meta.tenantId,
    name: meta.tenantName,
    status: 'ACTIVE',
    role: 'BILLER',
  });
});

it('GET /tenants/current devuelve la empresa creada por Java', async () => {
  const login = await http()
    .post('/api/v1/auth/login')
    .set('X-Forwarded-For', freshIp())
    .send({ email: meta.email, password: meta.password })
    .expect(200);
  const res = await http()
    .get('/api/v1/tenants/current')
    .set('Authorization', bearer((login.body as { accessToken: string }).accessToken))
    .expect(200);
  expect(res.body).toEqual({
    id: meta.tenantId,
    name: meta.tenantName,
    status: 'ACTIVE',
    role: 'OWNER',
  });
});

describe('el access token de Java', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('se acepta con el reloj fijado antes de su exp', async () => {
    // Solo Date: los temporizadores reales siguen moviendo las conexiones.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((meta.accessTokenIat + 1) * 1000);
    const res = await http()
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(meta.accessToken))
      .expect(200);
    expect(res.body).toMatchObject({ id: meta.userId, email: meta.email });
  });

  it('se rechaza pasado su exp y el minuto de tolerancia', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((meta.accessTokenExp + 61) * 1000);
    await http().get('/api/v1/auth/me').set('Authorization', bearer(meta.accessToken)).expect(401);
  });
});

describe('datos de E2 escritos por Java', () => {
  let token: string;

  beforeAll(async () => {
    const login = await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', freshIp())
      .send({ email: meta.email, password: meta.password })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  });

  const read = async (path: string) =>
    (await http().get(path).set('Authorization', bearer(token)).expect(200)).body as unknown;

  it('el emisor, el cliente y el producto de Java se leen igual', async () => {
    expect(await read(`/api/v1/taxpayers/${meta.taxpayerId}`)).toEqual(meta.views.taxpayer);
    expect(await read(`/api/v1/taxpayers/${meta.taxpayerId}/establishments`)).toEqual([meta.views.establishment]);
    expect(
      await read(`/api/v1/emission-points?establishmentId=${meta.views.establishment.id as string}`),
    ).toEqual([meta.views.emissionPoint]);
    expect(await read(`/api/v1/customers/${meta.customerId}`)).toEqual(meta.views.customer);
    expect(await read(`/api/v1/products/${meta.productId}`)).toEqual(meta.views.product);
    expect(await read(`/api/v1/certificates?taxpayerId=${meta.taxpayerId}`)).toEqual([meta.views.certificate]);
  });

  it('el certificado que cargó Java se descifra y su clave corresponde al certificado', async () => {
    const material = await testApp.app
      .get(CertificateService)
      .signingMaterial(meta.tenantId, meta.taxpayerId, new Date());
    expect(createHash('sha256').update(material.certificateDer).digest('hex')).toBe(meta.certificateFingerprint);
    expect(material.certificate.subject).toBe(meta.views.certificate.subject);
  });
});

/** Lo que tools/java-dump guardó de las emisiones de Java: su clave y el texto exacto del cuerpo. */
type JavaDocument = 'invoice' | 'creditNote' | 'manualCreditNote' | 'debitNote';
const requests = JSON.parse(readFileSync(path.join(fixtures, 'requests.json'), 'utf8')) as Record<
  JavaDocument,
  { path: string; key: string; body: string }
>;
/** Lo que Java respondió a GET /documents/{id} de cada comprobante y a GET /documents. */
const views = JSON.parse(readFileSync(path.join(fixtures, 'views.json'), 'utf8')) as Record<
  JavaDocument | 'list',
  Record<string, unknown>
>;

describe('comprobantes de E3 emitidos por Java', () => {
  let owner: Record<string, string>;
  const ids = (): Record<JavaDocument, string> => ({
    invoice: meta.invoiceId,
    creditNote: meta.creditNoteId,
    manualCreditNote: meta.manualCreditNoteId,
    debitNote: meta.debitNoteId,
  });

  beforeAll(async () => {
    const login = await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', freshIp())
      .send({ email: meta.email, password: meta.password })
      .expect(200);
    owner = {
      Authorization: bearer((login.body as { accessToken: string }).accessToken),
      'X-Tenant-Id': meta.tenantId,
    };
  });

  it('los comprobantes que emitió Java se ven igual', async () => {
    // La factura tiene authorized_at con microsegundos: Jackson los escribe con seis decimales.
    expect(views.invoice.authorizedAt).toMatch(/\.\d{6}Z$/);
    for (const [name, id] of Object.entries(ids()) as Array<[JavaDocument, string]>) {
      const res = await http().get(`/api/v1/documents/${id}`).set(owner).expect(200);
      expect({ name, body: withoutCorrelation(res.body) }).toEqual({ name, body: views[name] });
      expect(Object.keys(res.body as object)).toEqual(Object.keys(views[name]));
    }
    const list = await http().get('/api/v1/documents').set(owner).expect(200);
    expect(JSON.stringify(withoutCorrelation(list.body))).toBe(JSON.stringify(views.list));
  });

  it('el reintento con la clave que registró Java devuelve el mismo comprobante', async () => {
    // Mismo texto y misma clave: la huella de NestJS es la que guardó Java, incluidos los números JSON.
    for (const [name, id] of Object.entries(ids()) as Array<[JavaDocument, string]>) {
      const request = requests[name];
      const res = await http()
        .post(request.path)
        .set(owner)
        .set('Idempotency-Key', request.key)
        .set('Content-Type', 'application/json')
        .send(request.body);
      expect({ name, status: res.status, body: res.body as unknown }).toEqual({
        name,
        status: 202,
        // El estado es el de ahora: la factura ya está autorizada; las notas siguen en RESERVED.
        body: { id, state: views[name].state, statusUrl: `/api/v1/documents/${id}` },
      });
    }
    // La misma clave con otra petición es un conflicto, también si solo cambia el texto de un número
    // JSON (20.0 en vez de 20.00): Java lo guarda con su escala.
    const changed = JSON.parse(requests.invoice.body) as { payments: Array<{ amount: unknown }> };
    changed.payments[0]!.amount = '18.76';
    for (const body of [JSON.stringify(changed), requests.invoice.body.replace('"amount":20.00', '"amount":20.0')]) {
      expect(body).not.toBe(requests.invoice.body);
      const res = await http()
        .post(requests.invoice.path)
        .set(owner)
        .set('Idempotency-Key', requests.invoice.key)
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(409);
      expect(res.body).toMatchObject({ errorCode: 'IDEMPOTENCY_KEY_REUSED' });
    }
  });

  it('una nota de crédito nueva cuenta la que emitió Java en el saldo', async () => {
    const invoice = views.invoice as { total: string; creditedTotal: string };
    const balance = BigDecimal.of(invoice.total).subtract(BigDecimal.of(invoice.creditedTotal)).toString();
    // 38.75 de la factura menos 11.50 de la nota de crédito de Java.
    expect(balance).toBe('27.25');
    // Devolver la factura entera (38.75: las dos líneas completas) supera el saldo.
    const res = await http()
      .post('/api/v1/credit-notes')
      .set(owner)
      .set('Idempotency-Key', randomUUID())
      .send({
        taxpayerId: meta.taxpayerId,
        establishmentCode: '001',
        emissionPointCode: '001',
        reason: 'Devolución total',
        invoiceId: meta.invoiceId,
        lines: [
          { invoiceLineNo: 1, quantity: '2' },
          { invoiceLineNo: 2, quantity: '3' },
        ],
      })
      .expect(422);
    expect(res.body).toMatchObject({
      errorCode: 'CREDIT_EXCEEDS_INVOICE',
      detail: `Las notas de crédito de la factura superarían su total; saldo disponible: ${balance}`,
    });
  });
});

describe('firma y SRI (E4) con lo que dejó Java', () => {
  const signedXml = async (id: string) =>
    (await testApp.app.get(ArtifactStore).find(testApp.app.get<symbol, Kysely<DB>>(DATABASE), meta.tenantId, id, 'XML_SIGNED'))!
      .content;

  it('NestJS firma con el certificado que cargó Java y la firma verifica', async () => {
    // La nota de crédito escrita a mano quedó en RESERVED en Java.
    expect(await processDocument(testApp.app, meta.tenantId, meta.manualCreditNoteId)).toBe('SIGNED');
    const xml = await signedXml(meta.manualCreditNoteId);
    expect(new XadesVerifier().verify(xml)).toEqual({ valid: true, errors: [] });
    // Firmado con el certificado de Java: su huella es la que Java guardó.
    const certificate = /<ds:X509Certificate>([^<]+)</.exec(xml.toString('utf8'))![1]!;
    expect(createHash('sha256').update(Buffer.from(certificate, 'base64')).digest('hex')).toBe(
      meta.certificateFingerprint,
    );
  });

  it('un comprobante emitido por Java llega a AUTORIZADO con el pipeline de NestJS', async () => {
    const pipeline = testApp.app.get(DocumentPipeline);
    let state = '';
    for (let step = 0; step < 10 && state !== 'AUTHORIZED'; step++) {
      state = await pipeline.advance(meta.tenantId, meta.debitNoteId);
    }
    expect(state).toBe('AUTHORIZED');
    expect(new XadesVerifier().verify(await signedXml(meta.debitNoteId)).valid).toBe(true);
    const artifacts = await testApp.app
      .get(ArtifactStore)
      .exists(testApp.app.get<symbol, Kysely<DB>>(DATABASE), meta.tenantId, meta.debitNoteId, 'SRI_AUTHORIZATION');
    expect(artifacts).toBe(true);
  });
});

describe('archivo y entrega (E5) de lo que emitió Java', () => {
  const token = async () =>
    (
      (
        await testApp.http
          .post('/api/v1/auth/login')
          .set('X-Forwarded-For', freshIp())
          .send({ email: meta.email, password: meta.password })
          .expect(200)
      ).body as { accessToken: string }
    ).accessToken;

  it.each([
    ['invoiceId', 'factura', 'Factura ', 'FACTURA'],
    ['creditNoteId', 'nota-credito', 'Nota de crédito ', 'NOTA DE CRÉDITO'],
    ['debitNoteId', 'nota-debito', 'Nota de débito ', 'NOTA DE DÉBITO'],
  ] as const)('%s se archiva, se entrega y se descarga', async (key, stem, subject, title) => {
    const id = meta[key];
    const db = testApp.app.get<symbol, Kysely<DB>>(DATABASE);
    if (key === 'invoiceId') {
      // El volcado la dejó en AUTHORIZED por SQL, sin firma ni autorización: aquí hace su recorrido.
      await sql`UPDATE fiscal_documents SET state = 'RESERVED' WHERE id = ${id}`.execute(db);
    }
    await sql`UPDATE fiscal_documents SET customer_email = 'receptor@example.test' WHERE id = ${id}`.execute(db);
    let state = '';
    for (let step = 0; step < 10 && state !== 'AUTHORIZED'; step++) {
      state = await testApp.app.get(DocumentPipeline).advance(meta.tenantId, id);
    }
    expect(state).toBe('AUTHORIZED');

    expect(await testApp.app.get(DeliveryService).process(meta.tenantId, id)).toBe(1);

    const mail = testApp.smtp.messages().find((message) => message.subject.startsWith(subject));
    expect(mail?.to).toContain('receptor@example.test');
    const owner = { Authorization: `Bearer ${await token()}`, 'X-Tenant-Id': meta.tenantId };
    const ride = await testApp.http.get(`/api/v1/documents/${id}/artifacts/ride`).set(owner).responseType('blob').expect(200);
    expect(ride.headers['content-disposition']).toMatch(new RegExp(`filename="${stem}-[0-9]{3}-[0-9]{3}-[0-9]{9}-ride[.]pdf"`));
    const text = await pdfText(ride.body as Buffer);
    expect(text).toContain(title);
    const row = await sql<{ access_key: string; customer_name: string }>`
      SELECT access_key, customer_name FROM fiscal_documents WHERE id = ${id}`.execute(db);
    expect(text).toContain(row.rows[0]!.access_key);
    expect(text).toContain(row.rows[0]!.customer_name);
    const xml = await testApp.http
      .get(`/api/v1/documents/${id}/artifacts/xml-authorized`)
      .set(owner)
      .responseType('blob')
      .expect(200);
    expect((xml.body as Buffer).toString('utf8')).toContain(
      `<numeroAutorizacion>${row.rows[0]!.access_key}</numeroAutorizacion>`,
    );
    const deliveries = await testApp.http.get(`/api/v1/documents/${id}/deliveries`).set(owner).expect(200);
    expect(deliveries.body).toMatchObject([{ status: 'SENT', automatic: true, recipient: 'receptor@example.test' }]);
  });
});

function withoutCorrelation(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const { correlationId: _ignored, ...rest } = body as Record<string, unknown>;
  return rest;
}
