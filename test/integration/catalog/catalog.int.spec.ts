import type { Kysely } from 'kysely';
import { CatalogRepository } from '../../../src/catalog/catalog.repository.js';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { registerAndLogin, startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de CatalogIT: los catálogos sembrados son los de la ficha técnica v2.34 (tablas 6, 17 y 24).
let stack: StackHandle;
let testApp: TestApp;
let catalogs: CatalogRepository;
let db: Kysely<DB>;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
  catalogs = testApp.app.get(CatalogRepository);
  db = testApp.app.get<Kysely<DB>>(DATABASE);
}, 300_000);
afterAll(async () => {
  await testApp?.close();
  await stack?.stop();
});

const http = () => testApp.http;

async function get(path: string): Promise<unknown> {
  const { accessToken } = await registerAndLogin(http());
  const res = await http().get(path).set('Authorization', `Bearer ${accessToken}`).expect(200);
  return res.body;
}

it('los tipos de identificación son los de la ficha', async () => {
  const body = (await get('/api/v1/catalogs/identification-types')) as Array<{ code: string; name: string }>;
  expect(body.map((t) => t.code)).toEqual(['04', '05', '06', '07', '08']);
  expect(body[3]).toEqual({ code: '07', name: 'VENTA A CONSUMIDOR FINAL' });
});

it('las formas de pago son las de la ficha, con sus fechas', async () => {
  const body = (await get('/api/v1/catalogs/payment-methods')) as Array<Record<string, unknown>>;
  expect(body.map((m) => m.code)).toEqual(['01', '15', '16', '17', '18', '19', '20', '21']);
  expect(body[0]).toEqual({
    code: '01',
    name: 'SIN UTILIZACION DEL SISTEMA FINANCIERO',
    validFrom: '2013-01-01',
    validTo: null,
  });
});

it('las tarifas de IVA son las de la ficha, con dos decimales', async () => {
  const body = (await get('/api/v1/catalogs/tax-rates')) as Array<Record<string, string>>;
  expect(body.filter((r) => r.taxCode === '2').map((r) => `${r.rateCode}=${r.rate}`)).toEqual([
    '0=0.00',
    '2=12.00',
    '3=14.00',
    '4=15.00',
    '5=5.00',
    '6=0.00',
    '7=0.00',
    '8=8.00',
    '10=13.00',
  ]);
  expect(Object.keys(body[0]!)).toEqual(['taxCode', 'rateCode', 'description', 'rate']);
  expect((await catalogs.ivaRate(db, '4'))?.toFixed(2)).toBe('15.00');
  expect(await catalogs.ivaRate(db, '9')).toBeNull();
});

it('los catálogos exigen autenticación', async () => {
  await http().get('/api/v1/catalogs/tax-rates').expect(401);
});

it('la vigencia de una forma de pago sigue sus fechas', async () => {
  expect(await catalogs.paymentMethodValidOn(db, '16', '2016-05-31')).toBe(false);
  expect(await catalogs.paymentMethodValidOn(db, '16', '2016-06-01')).toBe(true);
  expect(await catalogs.paymentMethodValidOn(db, '01', '2026-10-10')).toBe(true);
  expect(await catalogs.paymentMethodValidOn(db, '99', '2026-10-10')).toBe(false);
  expect(await catalogs.identificationType(db, '07')).toEqual({
    code: '07',
    name: 'VENTA A CONSUMIDOR FINAL',
    idNumberPattern: '9{13}',
    finalConsumer: true,
  });
  expect(await catalogs.identificationType(db, '09')).toBeNull();
});

it('solo el número de consumidor final completo es de consumidor final', async () => {
  expect(await catalogs.isFinalConsumerNumber(db, '9999999999999')).toBe(true);
  expect(await catalogs.isFinalConsumerNumber(db, '99999999999990')).toBe(false);
  expect(await catalogs.isFinalConsumerNumber(db, '999999999999')).toBe(false);
});

it('una API key también lee los catálogos: no dependen de la empresa', async () => {
  const owner = await registerAndLogin(http());
  const auth = `Bearer ${owner.accessToken}`;
  await http().post('/api/v1/tenants').set('Authorization', auth).send({ name: 'Empresa' }).expect(201);
  const key = await http().post('/api/v1/api-keys').set('Authorization', auth).send({ name: 'ERP' }).expect(201);
  await http()
    .get('/api/v1/catalogs/identification-types')
    .set('X-Api-Key', (key.body as { key: string }).key)
    .expect(200);
});
