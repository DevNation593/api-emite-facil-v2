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
import { createHash } from 'node:crypto';
import { CertificateService } from '../../../src/certificate/certificate.service.js';

/**
 * Datos escritos por la API Java (tools/java-dump): una cuenta, su sesión, una empresa y una API key.
 * NestJS los lee sin que Java vuelva a correr. Si una prueba falla es una incompatibilidad real: se
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
  views: Record<'taxpayer' | 'establishment' | 'emissionPoint' | 'customer' | 'product' | 'certificate', Record<string, unknown>>;
  env: { EINVOICE_JWT_SECRET: string; EINVOICE_MASTER_KEY: string };
}

const meta = JSON.parse(readFileSync(path.join(fixtures, 'meta.json'), 'utf8')) as JavaMeta;

let postgres: PostgresHandle;
let rabbit: RabbitHandle;
let redis: RedisHandle;
let testApp: TestApp;

beforeAll(async () => {
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
    meta.env,
  );
});
afterAll(async () => {
  await testApp?.close();
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
