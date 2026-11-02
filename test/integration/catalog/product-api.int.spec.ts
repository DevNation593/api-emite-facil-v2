import pg from 'pg';
import { CatalogRepository } from '../../../src/catalog/catalog.repository.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { bearer, createProduct, memberToken, newOwner, productJson } from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de ProductApiIT.
const PRODUCTS = '/api/v1/products';
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let owner: string;
let tenant: string;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});
beforeEach(async () => {
  ({ token: owner, tenant } = await newOwner(testApp.http));
});

const http = () => testApp.http;
const post = (token: string, body: unknown) =>
  http().post(PRODUCTS).set('Authorization', bearer(token)).send(body as object);
const put = (token: string, id: string, body: unknown) =>
  http().put(`${PRODUCTS}/${id}`).set('Authorization', bearer(token)).send(body as object);
const get = (token: string, path = PRODUCTS, query: Record<string, string> = {}) =>
  http().get(path).query(query).set('Authorization', bearer(token));
const del = (token: string, id: string) => http().delete(`${PRODUCTS}/${id}`).set('Authorization', bearer(token));
const count = async (text: string, params: unknown[]) =>
  Number((await db.query<{ n: string }>(text, params)).rows[0]!.n);

it('el administrador da de alta un producto', async () => {
  const admin = await memberToken(http(), db, tenant, 'ADMIN');
  const res = await post(admin, productJson('SRV-001', '10.5', '4')).expect(201);
  expect(res.body).toEqual({
    id: expect.any(String),
    sku: 'SRV-001',
    name: 'Servicio de consultoría',
    unitPrice: '10.500000',
    ivaRateCode: '4',
  });
  expect(Object.keys(res.body)).toEqual(['id', 'sku', 'name', 'unitPrice', 'ivaRateCode']);
  const id = (res.body as { id: string }).id;
  expect((await get(admin, `${PRODUCTS}/${id}`).expect(200)).body.unitPrice).toBe('10.500000');
  expect(
    await count(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'PRODUCT_CREATED' AND entity_id = $1 AND tenant_id = $2",
      [id, tenant],
    ),
  ).toBe(1);
});

it('el facturador no da de alta productos, pero lista', async () => {
  const biller = await memberToken(http(), db, tenant, 'BILLER');
  const res = await post(biller, productJson('SRV-001', '10.00', '4')).expect(403);
  expect(res.body.errorCode).toBe('ROLE_FORBIDDEN');
  await get(biller).expect(200);
});

it('conserva seis decimales y el precio cero', async () => {
  expect((await post(owner, productJson('P-1', '0.000001', '0')).expect(201)).body.unitPrice).toBe('0.000001');
  expect((await post(owner, productJson('P-2', '0', '0')).expect(201)).body.unitPrice).toBe('0.000000');
  expect((await post(owner, productJson('P-3', '999999999999.999999', '4')).expect(201)).body.unitPrice).toBe(
    '999999999999.999999',
  );
});

it('rechaza un precio inválido sin dejar nada', async () => {
  for (const price of ['-1', '1.1234567', '1e3', '1,5', '', ' 1', '1234567890123']) {
    const res = await post(owner, productJson('P-X', price, '4')).expect(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
    expect(res.body.errors[0].field).toBe('unitPrice');
  }
  const missing = await post(owner, { sku: 'P-X', name: 'X', ivaRateCode: '4' }).expect(400);
  expect(missing.body.errors[0].field).toBe('unitPrice');
  expect(await count('SELECT count(*) AS n FROM products WHERE tenant_id = $1', [tenant])).toBe(0);
});

it('rechaza un código o un nombre inválidos', async () => {
  for (const sku of ['', 'con espacio', 'x'.repeat(26), 'ñandú']) {
    const res = await post(owner, productJson(sku, '1.00', '4')).expect(400);
    expect(res.body.errors[0].field).toBe('sku');
  }
  const res = await post(owner, { ...productJson('P-1', '1.00', '4'), name: ' ' }).expect(400);
  expect(res.body.errors[0].field).toBe('name');
});

it('una tarifa de IVA desconocida se rechaza', async () => {
  const res = await post(owner, productJson('P-1', '1.00', '9')).expect(422);
  expect(res.body).toMatchObject({ errorCode: 'TAX_RATE_UNKNOWN', detail: 'La tarifa de IVA no existe en el catálogo' });
});

it('un código repetido es conflicto, pero no en otra empresa', async () => {
  await createProduct(http(), owner, 'P-1', '1.00', '4');
  const res = await post(owner, productJson('P-1', '2.00', '0')).expect(409);
  expect(res.body).toMatchObject({ errorCode: 'PRODUCT_SKU_TAKEN', detail: 'Ya existe un producto con ese código' });
  const other = (await newOwner(http())).token;
  await createProduct(http(), other, 'P-1', '1.00', '4');
});

it('busca y pagina', async () => {
  for (let i = 0; i < 23; i++) {
    await createProduct(http(), owner, `${i < 2 ? 'ZZ-' : 'P-'}${i}`, '1.00', '4');
  }
  const page = await get(owner, PRODUCTS, { size: '10' }).expect(200);
  expect(page.body.items).toHaveLength(10);
  expect(page.body.total).toBe(23);
  expect((await get(owner, PRODUCTS, { q: 'zz-' })).body.total).toBe(2);
  expect((await get(owner, PRODUCTS, { q: 'CONSULTOR' })).body.total).toBe(23);
  expect((await get(owner, PRODUCTS, { q: '_' })).body.total).toBe(0);
  await get(owner, PRODUCTS, { size: '101' }).expect(400);
});

it('el producto de otra empresa no existe', async () => {
  const product = await createProduct(http(), owner, 'P-1', '1.00', '4');
  const other = (await newOwner(http())).token;
  const res = await get(other, `${PRODUCTS}/${product}`).expect(404);
  expect(res.body.errorCode).toBe('NOT_FOUND');
  expect((await get(other)).body.total).toBe(0);
});

it('el administrador edita un producto y el facturador no puede cambiarlo', async () => {
  const id = await createProduct(http(), owner, 'P-1', '10.00', '4');
  const admin = await memberToken(http(), db, tenant, 'ADMIN');
  const update = productJson('P-2', '12.5', '0');
  const res = await put(admin, id, update).expect(200);
  expect(res.body).toMatchObject({ id, sku: 'P-2', unitPrice: '12.500000', ivaRateCode: '0' });
  expect(
    await count("SELECT count(*) AS n FROM audit_events WHERE action = 'PRODUCT_UPDATED' AND entity_id = $1", [id]),
  ).toBe(1);
  const biller = await memberToken(http(), db, tenant, 'BILLER');
  await put(biller, id, update).expect(403);
  await del(biller, id).expect(403);
});

it('un producto borrado desaparece y su código se puede reutilizar', async () => {
  const id = await createProduct(http(), owner, 'P-1', '10.00', '4');
  await del(owner, id).expect(204);
  await get(owner, `${PRODUCTS}/${id}`).expect(404);
  expect((await get(owner)).body.total).toBe(0);
  const row = await db.query('SELECT deleted_at IS NOT NULL AS deleted FROM products WHERE id = $1', [id]);
  expect(row.rows[0].deleted).toBe(true);
  await post(owner, productJson('P-1', '8.00', '4')).expect(201);
  await del(owner, id).expect(404);
});

it('la edición valida la tarifa y la unicidad del código', async () => {
  const first = await createProduct(http(), owner, 'P-1', '10.00', '4');
  await createProduct(http(), owner, 'P-2', '10.00', '4');
  expect((await put(owner, first, productJson('P-2', '10.00', '4')).expect(409)).body.errorCode).toBe(
    'PRODUCT_SKU_TAKEN',
  );
  expect((await put(owner, first, productJson('P-3', '10.00', '9')).expect(422)).body.errorCode).toBe(
    'TAX_RATE_UNKNOWN',
  );
  expect((await get(owner, `${PRODUCTS}/${first}`)).body.sku).toBe('P-1');
});

it('otra empresa no edita ni borra el producto', async () => {
  const id = await createProduct(http(), owner, 'P-1', '10.00', '4');
  const other = (await newOwner(http())).token;
  await put(other, id, productJson('P-2', '20.00', '0')).expect(404);
  await del(other, id).expect(404);
  await get(owner, `${PRODUCTS}/${id}`).expect(200);
});

it('una edición obsoleta no revive un producto que otra petición acaba de borrar', async () => {
  const id = await createProduct(http(), owner, 'P-1', '10.00', '4');
  const original = Object.getOwnPropertyDescriptor(CatalogRepository.prototype, 'ivaRate')!
    .value as CatalogRepository['ivaRate'];
  const spy = vi
    .spyOn(CatalogRepository.prototype, 'ivaRate')
    .mockImplementationOnce(async function (this: CatalogRepository, ...args) {
      await db.query('UPDATE products SET deleted_at = now(), version = version + 1 WHERE id = $1', [id]);
      return Reflect.apply(original, this, args);
    });
  try {
    const res = await put(owner, id, productJson('P-1', '10.00', '4')).expect(409);
    expect(res.body).toMatchObject({
      errorCode: 'CATALOG_CHANGED',
      detail: 'El producto cambió. Recargue la lista e inténtelo de nuevo',
    });
  } finally {
    spy.mockRestore();
  }
  await get(owner, `${PRODUCTS}/${id}`).expect(404);
});
