import pg from 'pg';
import { isValidAccessKey } from '../../../src/sequence/access-key.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { billingScenario, invoiceJson, issueInvoice } from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

/*
 * Traducción de SequenceConcurrencyIT: emisiones simultáneas sobre el mismo punto de emisión no repiten
 * secuencial ni clave de acceso y no dejan huecos. Más la del pool pequeño: cada lectura de la
 * emisión va por la transacción abierta, así que ninguna espera una segunda conexión.
 */
let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack, { EINVOICE_RATE_LIMIT_WRITES: '1000000' });
  // Escuchando de antemano: si no, supertest abre un puerto por petición simultánea.
  await testApp.app.listen(0, '127.0.0.1');
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});

async function expectConsecutive(app: TestApp, total: number): Promise<void> {
  const s = await billingScenario(app.http, db);
  const body = invoiceJson(s, '1', '11.50');
  const issued = await Promise.all(Array.from({ length: total }, () => issueInvoice(app.http, s.owner, body)));

  expect(new Set(issued).size).toBe(total);
  const rows = await db.query<{ sequence: number; access_key: string }>(
    'SELECT sequence, access_key FROM fiscal_documents WHERE tenant_id = $1 ORDER BY sequence',
    [s.tenant],
  );
  expect(rows.rows.map((r) => r.sequence)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  const keys = rows.rows.map((r) => r.access_key);
  expect(new Set(keys).size).toBe(total);
  expect(keys.every(isValidAccessKey)).toBe(true);
  const count = async (sql: string) => Number((await db.query<{ n: string }>(sql, [s.tenant])).rows[0]!.n);
  expect(await count('SELECT count(*) AS n FROM outbox_events WHERE tenant_id = $1')).toBe(total);
  expect(await count('SELECT count(*) AS n FROM state_events WHERE tenant_id = $1')).toBe(total);
  expect(await count('SELECT next_value AS n FROM document_sequences WHERE tenant_id = $1')).toBe(total + 1);
}

it('20 emisiones simultáneas dan los secuenciales 1 a 20 y claves de acceso distintas', async () => {
  await expectConsecutive(testApp, 20);
});

it('con un pool de 2 conexiones, 10 emisiones simultáneas terminan todas', async () => {
  const small = await startTestApp(stack, { DB_POOL_SIZE: '2', EINVOICE_RATE_LIMIT_WRITES: '1000000' });
  try {
    await small.app.listen(0, '127.0.0.1');
    await expectConsecutive(small, 10);
  } finally {
    await small.close();
  }
}, 120_000);
