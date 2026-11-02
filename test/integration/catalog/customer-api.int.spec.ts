import pg from 'pg';
import { CatalogRepository } from '../../../src/catalog/catalog.repository.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { bearer, createCustomer, customerJson, memberToken, newOwner } from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de CustomerApiIT. removingCustomerAndProductPreservesIssuedInvoice llega en E3.
const CUSTOMERS = '/api/v1/customers';
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
  http().post(CUSTOMERS).set('Authorization', bearer(token)).send(body as object);
const put = (token: string, id: string, body: unknown) =>
  http().put(`${CUSTOMERS}/${id}`).set('Authorization', bearer(token)).send(body as object);
const get = (token: string, path = CUSTOMERS, query: Record<string, string> = {}) =>
  http().get(path).query(query).set('Authorization', bearer(token));
const del = (token: string, id: string) => http().delete(`${CUSTOMERS}/${id}`).set('Authorization', bearer(token));
const auditMetadata = async (action: string, id: string) =>
  (await db.query<{ m: string }>('SELECT metadata::text AS m FROM audit_events WHERE action = $1 AND entity_id = $2', [action, id]))
    .rows[0]!.m;

it('el facturador da de alta un cliente', async () => {
  const biller = await memberToken(http(), db, tenant, 'BILLER');
  const res = await post(biller, customerJson('05', '1712345678', 'María Pérez')).expect(201);
  expect(res.body).toEqual({
    id: expect.any(String),
    idType: '05',
    idNumber: '1712345678',
    name: 'María Pérez',
    email: 'cliente@example.test',
    address: 'Av. República, Quito',
    phone: '022345678',
  });
  expect(Object.keys(res.body)).toEqual(['id', 'idType', 'idNumber', 'name', 'email', 'address', 'phone']);
  const read = await get(biller, `${CUSTOMERS}/${(res.body as { id: string }).id}`).expect(200);
  expect(read.body.address).toBe('Av. República, Quito');
});

it('los campos en blanco se guardan como null y el nombre se recorta', async () => {
  const res = await post(owner, {
    idType: '05',
    idNumber: '1700000009',
    name: '  Nombre  ',
    email: '',
    address: '  ',
    phone: ' ',
  }).expect(201);
  expect(res.body).toMatchObject({ name: 'Nombre', email: null, address: null, phone: null });
});

it('el auditor no da de alta, pero lista', async () => {
  const auditor = await memberToken(http(), db, tenant, 'AUDITOR');
  const res = await post(auditor, customerJson('05', '1712345678', 'María Pérez')).expect(403);
  expect(res.body.errorCode).toBe('ROLE_FORBIDDEN');
  await get(auditor).expect(200);
});

it('un tipo de identificación desconocido se rechaza', async () => {
  const res = await post(owner, customerJson('09', '1712345678', 'María Pérez')).expect(422);
  expect(res.body).toMatchObject({
    errorCode: 'IDENTIFICATION_TYPE_UNKNOWN',
    detail: 'El tipo de identificación no existe en el catálogo',
  });
});

it('la identificación se valida según su tipo', async () => {
  const invalid = [
    ['04', '179001234500'],
    ['04', '17900123450012'],
    ['05', '171234567'],
    ['05', '17123456789'],
    ['07', '9999999999998'],
    ['07', '1712345678'],
    ['06', 'AB'],
    ['06', 'AB-123'],
    ['08', 'X'.repeat(21)],
  ];
  for (const [type, number] of invalid) {
    const res = await post(owner, customerJson(type!, number!, 'María Pérez'));
    expect([400, 422], `${type} ${number}`).toContain(res.status);
  }
  for (const [type, number] of [
    ['04', '1790012345001'],
    ['05', '1712345678'],
    ['06', 'AB123456'],
    ['07', '9999999999999'],
    ['08', 'X1234567890'],
  ]) {
    await post(owner, customerJson(type!, number!, 'María Pérez')).expect(201);
  }
  const res = await post(owner, customerJson('05', '171234567', 'María Pérez')).expect(422);
  expect(res.body).toMatchObject({
    errorCode: 'IDENTIFICATION_INVALID',
    detail: 'La identificación no tiene el formato de su tipo',
  });
});

it('el número de consumidor final queda reservado a su tipo', async () => {
  for (const type of ['04', '06', '08']) {
    const res = await post(owner, customerJson(type, '9999999999999', 'Sin identificar')).expect(422);
    expect(res.body.errorCode).toBe('IDENTIFICATION_INVALID');
  }
  await post(owner, customerJson('07', '9999999999999', 'CONSUMIDOR FINAL')).expect(201);
});

it('rechaza parámetros de búsqueda y de página inservibles', async () => {
  const nul = String.fromCharCode(0);
  const res = await get(owner, CUSTOMERS, { q: `a${nul}b` }).expect(400);
  expect(res.body.errorCode).toBe('MALFORMED_REQUEST');
  await get(owner, CUSTOMERS, { q: 'x'.repeat(101) }).expect(400);
  const page = await get(owner, CUSTOMERS, { page: '2147483647', size: '100' }).expect(400);
  expect(page.body.errorCode).toBe('MALFORMED_REQUEST');
  await get(owner, '/api/v1/products', { page: '30000000', size: '100' }).expect(400);
  await get(owner, '/api/v1/products', { q: nul }).expect(400);
});

it('rechaza campos inválidos', async () => {
  const blank = await post(owner, customerJson('05', '1712345678', '')).expect(400);
  expect(blank.body.errorCode).toBe('VALIDATION_FAILED');
  const email = await post(owner, { ...customerJson('05', '1712345678', 'María'), email: 'no-es-correo' }).expect(400);
  expect(email.body.errors[0].field).toBe('email');
});

it('una identificación repetida es conflicto', async () => {
  await createCustomer(http(), owner, '05', '1712345678');
  const res = await post(owner, customerJson('05', '1712345678', 'Otro Nombre')).expect(409);
  expect(res.body).toMatchObject({
    errorCode: 'CUSTOMER_ALREADY_EXISTS',
    detail: 'Ya existe un cliente con esa identificación',
  });
});

it('la misma identificación en otra empresa se admite', async () => {
  await createCustomer(http(), owner, '05', '1712345678');
  const other = (await newOwner(http())).token;
  await createCustomer(http(), other, '05', '1712345678');
});

it('busca y pagina', async () => {
  for (let i = 0; i < 25; i++) {
    const number = `17${String(i).padStart(8, '0')}`;
    await post(owner, customerJson('05', number, i < 3 ? `Zeta Comercial ${i}` : `Cliente ${i}`)).expect(201);
  }
  const first = await get(owner).expect(200);
  expect(first.body).toMatchObject({ page: 0, size: 20, total: 25 });
  expect(first.body.items).toHaveLength(20);
  expect(Object.keys(first.body)).toEqual(['items', 'page', 'size', 'total']);
  const second = await get(owner, CUSTOMERS, { page: '1', size: '20' }).expect(200);
  expect(second.body.items).toHaveLength(5);
  const zeta = await get(owner, CUSTOMERS, { q: 'zeta' }).expect(200);
  expect(zeta.body.total).toBe(3);
  expect(zeta.body.items[0].name).toBe('Zeta Comercial 0');
  expect((await get(owner, CUSTOMERS, { q: '170000002' })).body.total).toBe(5);
  expect((await get(owner, CUSTOMERS, { q: '%' })).body.total).toBe(0);
});

it.each([
  ['0', '0'],
  ['0', '101'],
  ['-1', '20'],
])('page %s y size %s fuera de rango dan 400', async (page, size) => {
  const res = await get(owner, CUSTOMERS, { page, size }).expect(400);
  expect(res.body).toMatchObject({
    errorCode: 'MALFORMED_REQUEST',
    detail: 'page debe estar entre 0 y 100000 y size entre 1 y 100',
  });
});

it('el cliente de otra empresa no existe', async () => {
  const customer = await createCustomer(http(), owner, '05', '1712345678');
  const other = (await newOwner(http())).token;
  const res = await get(other, `${CUSTOMERS}/${customer}`).expect(404);
  expect(res.body.errorCode).toBe('NOT_FOUND');
  expect((await get(other)).body.total).toBe(0);
});

it('la auditoría no guarda datos personales', async () => {
  const customer = await createCustomer(http(), owner, '05', '1712345678');
  const metadata = await auditMetadata('CUSTOMER_CREATED', customer);
  expect(JSON.parse(metadata)).toEqual({ idType: '05' });
});

it('el facturador edita un cliente y la auditoría no expone datos personales', async () => {
  const id = await createCustomer(http(), owner, '05', '1712345678');
  const biller = await memberToken(http(), db, tenant, 'BILLER');
  const update = customerJson('04', '1790012345001', 'Empresa Actualizada');
  const res = await put(biller, id, update).expect(200);
  expect(res.body).toMatchObject({ id, idType: '04', name: 'Empresa Actualizada' });
  expect((await get(owner, `${CUSTOMERS}/${id}`)).body.idNumber).toBe('1790012345001');
  const metadata = await auditMetadata('CUSTOMER_UPDATED', id);
  expect(metadata).not.toContain('1790012345001');
  expect(metadata).not.toContain('Empresa Actualizada');
  expect(metadata).not.toContain('cliente@example.test');
  const auditor = await memberToken(http(), db, tenant, 'AUDITOR');
  await put(auditor, id, update).expect(403);
  await del(auditor, id).expect(403);
});

it('un cliente borrado desaparece y su identificación se puede reutilizar', async () => {
  const id = await createCustomer(http(), owner, '05', '1712345678');
  await del(owner, id).expect(204);
  await get(owner, `${CUSTOMERS}/${id}`).expect(404);
  expect((await get(owner)).body.total).toBe(0);
  const row = await db.query('SELECT deleted_at IS NOT NULL AS deleted FROM customers WHERE id = $1', [id]);
  expect(row.rows[0].deleted).toBe(true);
  expect(JSON.parse(await auditMetadata('CUSTOMER_DELETED', id))).toEqual({ idType: '05' });
  await post(owner, customerJson('05', '1712345678', 'Nuevo cliente')).expect(201);
  await del(owner, id).expect(404);
});

it('la edición valida la identificación y su unicidad', async () => {
  const first = await createCustomer(http(), owner, '05', '1712345678');
  await createCustomer(http(), owner, '05', '1700000001');
  const duplicate = await put(owner, first, customerJson('05', '1700000001', 'Duplicado')).expect(409);
  expect(duplicate.body.errorCode).toBe('CUSTOMER_ALREADY_EXISTS');
  const invalid = await put(owner, first, customerJson('05', '123', 'Inválido')).expect(422);
  expect(invalid.body.errorCode).toBe('IDENTIFICATION_INVALID');
  expect((await get(owner, `${CUSTOMERS}/${first}`)).body.idNumber).toBe('1712345678');
});

it('otra empresa no edita ni borra el cliente', async () => {
  const id = await createCustomer(http(), owner, '05', '1712345678');
  const other = (await newOwner(http())).token;
  await put(other, id, customerJson('05', '1712345678', 'Otro')).expect(404);
  await del(other, id).expect(404);
  await get(owner, `${CUSTOMERS}/${id}`).expect(200);
});

it('una edición obsoleta no revive un cliente que otra petición acaba de borrar', async () => {
  const id = await createCustomer(http(), owner, '05', '1712345678');
  // El borrado se confirma entre la lectura del cliente y su escritura, como dos peticiones a la vez.
  const original = Object.getOwnPropertyDescriptor(CatalogRepository.prototype, 'identificationType')!
    .value as CatalogRepository['identificationType'];
  const spy = vi
    .spyOn(CatalogRepository.prototype, 'identificationType')
    .mockImplementationOnce(async function (this: CatalogRepository, ...args) {
      await db.query('UPDATE customers SET deleted_at = now(), version = version + 1 WHERE id = $1', [id]);
      return Reflect.apply(original, this, args);
    });
  try {
    const res = await put(owner, id, customerJson('05', '1712345678', 'Nombre anterior')).expect(409);
    expect(res.body).toMatchObject({
      errorCode: 'CATALOG_CHANGED',
      detail: 'El cliente cambió. Recargue la lista e inténtelo de nuevo',
    });
  } finally {
    spy.mockRestore();
  }
  await get(owner, `${CUSTOMERS}/${id}`).expect(404);
});
