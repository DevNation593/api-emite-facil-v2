import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  bearer,
  createEmissionPoint,
  createEstablishment,
  createTaxpayer,
  newOwner,
  randomRuc,
  sameProblem,
} from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

/*
 * Traducción de TenantIsolationIT, con las rutas portadas hasta E2. Dos empresas, A y B: ninguna
 * petición de B lee ni modifica nada de A, y la respuesta no distingue un recurso ajeno de uno
 * inexistente. Las pruebas de comprobantes llegan en E3.
 */
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;
let tokenA: string;
let tokenB: string;
let rucA: string;
let taxpayerA: string;

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
  tokenA = (await newOwner(testApp.http)).token;
  rucA = randomRuc();
  taxpayerA = await createTaxpayer(testApp.http, tokenA, rucA);
  tokenB = (await newOwner(testApp.http)).token;
  await createTaxpayer(testApp.http, tokenB);
});

const http = () => testApp.http;

async function notFoundBody(token: string, path: string): Promise<{ body: Record<string, unknown>; text: string }> {
  const res = await http().get(path).set('Authorization', bearer(token)).expect(404);
  return { body: res.body as Record<string, unknown>, text: res.text };
}

it('el emisor de otra empresa no existe', async () => {
  const foreign = await notFoundBody(tokenB, `/api/v1/taxpayers/${taxpayerA}`);
  const unknown = await notFoundBody(tokenB, `/api/v1/taxpayers/${randomUUID()}`);
  sameProblem(foreign.body, unknown.body);
  expect(foreign.text).not.toContain(rucA);
});

it('el listado nunca incluye otra empresa', async () => {
  const res = await http().get('/api/v1/taxpayers').set('Authorization', bearer(tokenB)).expect(200);
  expect(res.body).toHaveLength(1);
  expect((res.body as Array<{ ruc: string }>).map((t) => t.ruc)).not.toContain(rucA);
});

it('no se crea un establecimiento bajo un emisor ajeno', async () => {
  await createEstablishment(http(), tokenA, taxpayerA, '001');
  const res = await http()
    .post(`/api/v1/taxpayers/${taxpayerA}/establishments`)
    .set('Authorization', bearer(tokenB))
    .send({ code: '002', address: 'Guayaquil' })
    .expect(404);
  expect(res.body.errorCode).toBe('NOT_FOUND');
  const rows = await db.query('SELECT count(*) AS n FROM establishments WHERE taxpayer_id = $1', [taxpayerA]);
  expect(Number(rows.rows[0].n)).toBe(1);
});

it('no se listan los establecimientos de un emisor ajeno', async () => {
  await createEstablishment(http(), tokenA, taxpayerA, '001');
  const foreign = await notFoundBody(tokenB, `/api/v1/taxpayers/${taxpayerA}/establishments`);
  const unknown = await notFoundBody(tokenB, `/api/v1/taxpayers/${randomUUID()}/establishments`);
  sameProblem(foreign.body, unknown.body);
});

it('no se crea un punto de emisión bajo un establecimiento ajeno', async () => {
  const establishmentA = await createEstablishment(http(), tokenA, taxpayerA, '001');
  const res = await http()
    .post('/api/v1/emission-points')
    .set('Authorization', bearer(tokenB))
    .send({ establishmentId: establishmentA, code: '001' })
    .expect(404);
  expect(res.body.errorCode).toBe('NOT_FOUND');
  const rows = await db.query('SELECT count(*) AS n FROM emission_points WHERE establishment_id = $1', [
    establishmentA,
  ]);
  expect(Number(rows.rows[0].n)).toBe(0);
});

it('no se listan los puntos de emisión de un establecimiento ajeno', async () => {
  const establishmentA = await createEstablishment(http(), tokenA, taxpayerA, '001');
  await createEmissionPoint(http(), tokenA, establishmentA, '001');
  const foreign = await notFoundBody(tokenB, `/api/v1/emission-points?establishmentId=${establishmentA}`);
  const unknown = await notFoundBody(tokenB, `/api/v1/emission-points?establishmentId=${randomUUID()}`);
  sameProblem(foreign.body, unknown.body);
});
