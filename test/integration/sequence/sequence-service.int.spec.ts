import type { Kysely } from 'kysely';
import pg from 'pg';
import { ApiException } from '../../../src/common/api-exception.js';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { SequenceService } from '../../../src/sequence/sequence.service.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { randomRuc } from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de SequenceServiceIT.
const DAY = '2026-10-10';
let stack: StackHandle;
let testApp: TestApp;
let pgc: pg.Client;
let db: Kysely<DB>;
let sequences: SequenceService;
let tenant: string;
let establishment: string;
let point: string;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
  pgc = new pg.Client({ connectionString: stack.databaseUrl });
  await pgc.connect();
  db = testApp.app.get<Kysely<DB>>(DATABASE);
  sequences = testApp.app.get(SequenceService);
}, 300_000);
afterAll(async () => {
  await pgc?.end();
  await testApp?.close();
  await stack?.stop();
});

const one = async (text: string, params: unknown[]) => (await pgc.query(text, params)).rows[0];

async function emissionPoint(establishmentId: string, code: string): Promise<string> {
  return (
    await one('INSERT INTO emission_points (tenant_id, establishment_id, code) VALUES ($1, $2, $3) RETURNING id', [
      tenant,
      establishmentId,
      code,
    ])
  ).id;
}

beforeEach(async () => {
  tenant = (await one("INSERT INTO tenants (name) VALUES ('Empresa') RETURNING id", [])).id;
  const taxpayer = (
    await one(
      `INSERT INTO taxpayers (tenant_id, ruc, legal_name, head_office_address, default_environment)
       VALUES ($1, $2, 'Emisor', 'Quito', '1') RETURNING id`,
      [tenant, randomRuc()],
    )
  ).id;
  establishment = (
    await one(
      "INSERT INTO establishments (tenant_id, taxpayer_id, code, address) VALUES ($1, $2, '001', 'Quito') RETURNING id",
      [tenant, taxpayer],
    )
  ).id;
  point = await emissionPoint(establishment, '001');
});

const reserve = (emissionPointId: string, environment: string, date: string) =>
  db.transaction().execute((trx) => sequences.reserve(trx, tenant, emissionPointId, environment, '01', date));

it('empieza en uno y avanza', async () => {
  expect([await reserve(point, '1', DAY), await reserve(point, '1', DAY), await reserve(point, '1', DAY)]).toEqual([
    1, 2, 3,
  ]);
});

it('los contadores son independientes por ambiente y punto', async () => {
  const otherPoint = await emissionPoint(establishment, '002');
  expect(await reserve(point, '1', DAY)).toBe(1);
  expect(await reserve(point, '1', DAY)).toBe(2);
  expect(await reserve(point, '2', DAY)).toBe(1);
  expect(await reserve(otherPoint, '1', DAY)).toBe(1);
});

it('deshacer la transacción devuelve el número', async () => {
  let reserved = 0;
  await expect(
    db.transaction().execute(async (trx) => {
      reserved = await sequences.reserve(trx, tenant, point, '1', '01', DAY);
      throw new Error('se deshace');
    }),
  ).rejects.toThrow('se deshace');
  expect(reserved).toBe(1);
  expect(await reserve(point, '1', DAY)).toBe(1);
});

it('reservas simultáneas nunca repiten número', async () => {
  const workers = 8;
  const perWorker = 25;
  const all = (
    await Promise.all(
      Array.from({ length: workers }, async () => {
        const mine: number[] = [];
        for (let i = 0; i < perWorker; i++) mine.push(await reserve(point, '1', DAY));
        return mine;
      }),
    )
  ).flat();
  expect(all.sort((a, b) => a - b)).toEqual(Array.from({ length: workers * perWorker }, (_, i) => i + 1));
  const row = await one('SELECT next_value FROM document_sequences WHERE emission_point_id = $1', [point]);
  expect(Number(row.next_value)).toBe(201);
});

it('rechaza una fecha anterior a la del último comprobante', async () => {
  expect(await reserve(point, '1', DAY)).toBe(1);
  const error = await reserve(point, '1', '2026-10-09').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiException);
  expect(error).toMatchObject({
    status: 422,
    errorCode: 'INVALID_ISSUE_DATE',
    detail: 'La fecha de emisión no puede ser anterior a la del último comprobante del punto de emisión',
  });
  expect(await reserve(point, '1', DAY)).toBe(2);
  expect(await reserve(point, '1', '2026-10-11')).toBe(3);
});

it('un secuencial agotado se rechaza', async () => {
  await pgc.query(
    `INSERT INTO document_sequences (tenant_id, emission_point_id, environment, document_type, next_value)
     VALUES ($1, $2, '1', '01', 999999999)`,
    [tenant, point],
  );
  expect(await reserve(point, '1', DAY)).toBe(999_999_999);
  await expect(reserve(point, '1', DAY)).rejects.toMatchObject({
    status: 422,
    errorCode: 'SEQUENCE_EXHAUSTED',
    detail: 'El punto de emisión agotó sus secuenciales para este tipo de comprobante',
  });
});

it('exige una transacción abierta', async () => {
  await expect(
    sequences.reserve(db as never, tenant, point, '1', '01', DAY),
  ).rejects.toThrow('transacción');
});
