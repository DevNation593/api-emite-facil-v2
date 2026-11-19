import { Registry } from 'prom-client';
import { SriAttemptLog } from '../../../src/sri/sri-attempt-log.js';
import type { AuthorizationResult, ReceptionResult } from '../../../src/sri/sri-results.js';
import { insertDocument, newScenario, type Scenario } from '../../support/billing-data.js';
import { startDb, type DbHandle } from '../../support/db-handle.js';

// SriAttemptLog: SQL de sri/SriAttemptLog.java y el histograma einvoice_sri_calls_seconds.
let handle: DbHandle;
beforeAll(async () => {
  handle = await startDb();
}, 300_000);
afterAll(async () => {
  await handle?.stop();
});

let registry: Registry;
let log: SriAttemptLog;
let s: Scenario;
let document: string;
beforeEach(async () => {
  registry = new Registry();
  log = new SriAttemptLog(registry);
  s = await newScenario(handle.pgc);
  document = await insertDocument(handle.pgc, s, 1, { state: 'SENDING' });
});

const returned: ReceptionResult = {
  outcome: 'RETURNED',
  sriStatus: 'DEVUELTA',
  messages: [
    { identifier: '35', message: 'DOCUMENTO INVÁLIDO', additionalInfo: 'detalle', type: 'ERROR' },
    { identifier: '43', message: 'CLAVE ACCESO REGISTRADA', additionalInfo: null, type: 'ERROR' },
  ],
  httpStatus: 200,
  errorDetail: null,
  rawResponse: Buffer.from('<respuesta/>'),
};

const authorizedResult: AuthorizationResult = {
  outcome: 'AUTHORIZED',
  sriStatus: 'AUTORIZADO',
  consultedAccessKey: '1'.repeat(49),
  authorizationNumber: '1'.repeat(49),
  authorizedAt: '2012-03-05T16:57:34.997-05:00',
  environmentLabel: 'PRUEBAS',
  messages: [{ identifier: '60', message: 'AMBIENTE DE PRUEBAS', additionalInfo: null, type: 'ADVERTENCIA' }],
  httpStatus: 200,
  errorDetail: null,
  rawResponse: Buffer.from('<autorizacion/>'),
};

const attempt = async (id: string) =>
  (await handle.pgc.query('SELECT * FROM sri_attempts WHERE id = $1', [id])).rows[0] as Record<string, unknown>;

const messages = async (id: string) =>
  (
    await handle.pgc.query(
      'SELECT position, identifier, message, additional_info, type FROM sri_messages WHERE attempt_id = $1 ORDER BY position',
      [id],
    )
  ).rows;

it('start abre un intento sin resultado con el código del ambiente', async () => {
  const id = await log.start(handle.db, s.tenant, document, 'RECEPTION', 'TEST');
  expect(await attempt(id)).toMatchObject({
    tenant_id: s.tenant,
    document_id: document,
    operation: 'RECEPTION',
    environment: '1',
    outcome: null,
    completed_at: null,
  });
});

it('completeReception cierra el intento, guarda la respuesta y los mensajes desde la posición 1', async () => {
  const id = await log.start(handle.db, s.tenant, document, 'RECEPTION', 'PRODUCTION');
  expect(await log.completeReception(handle.db, id, 'RETURNED', returned)).toBe(true);
  const row = await attempt(id);
  expect(row).toMatchObject({
    outcome: 'RETURNED',
    sri_status: 'DEVUELTA',
    http_status: 200,
    error_detail: null,
    environment: '2',
  });
  expect((row.response as Buffer).toString()).toBe('<respuesta/>');
  expect(row.completed_at).not.toBeNull();
  expect(await messages(id)).toEqual([
    { position: 1, identifier: '35', message: 'DOCUMENTO INVÁLIDO', additional_info: 'detalle', type: 'ERROR' },
    { position: 2, identifier: '43', message: 'CLAVE ACCESO REGISTRADA', additional_info: null, type: 'ERROR' },
  ]);
});

it('un intento ya cerrado no se vuelve a cerrar ni recibe mensajes', async () => {
  const id = await log.start(handle.db, s.tenant, document, 'RECEPTION', 'TEST');
  expect(await log.abandonSends(handle.db, document)).toBe(1);
  expect(await log.completeReception(handle.db, id, 'RETURNED', returned)).toBe(false);
  expect(await attempt(id)).toMatchObject({ outcome: 'ABANDONED', sri_status: null, response: null });
  expect(await messages(id)).toEqual([]);
});

it('completeAuthorization guarda la respuesta solo si se pide', async () => {
  const kept = await log.start(handle.db, s.tenant, document, 'AUTHORIZATION', 'TEST');
  const dropped = await log.start(handle.db, s.tenant, document, 'AUTHORIZATION', 'TEST');
  expect(await log.completeAuthorization(handle.db, kept, 'AUTHORIZED', authorizedResult, true)).toBe(true);
  expect(await log.completeAuthorization(handle.db, dropped, 'AUTHORIZED', authorizedResult, false)).toBe(true);
  expect(((await attempt(kept)).response as Buffer).toString()).toBe('<autorizacion/>');
  expect((await attempt(dropped)).response).toBeNull();
  expect(await messages(dropped)).toHaveLength(1);
});

it('sendInFlight solo cuenta envíos abiertos dentro del plazo, y abandonSends los cierra', async () => {
  expect(await log.sendInFlight(handle.db, document, 60_000)).toBe(false);
  const open = await log.start(handle.db, s.tenant, document, 'RECEPTION', 'TEST');
  await log.start(handle.db, s.tenant, document, 'AUTHORIZATION', 'TEST');
  expect(await log.sendInFlight(handle.db, document, 60_000)).toBe(true);
  await handle.pgc.query("UPDATE sri_attempts SET started_at = now() - interval '2 minutes' WHERE id = $1", [open]);
  expect(await log.sendInFlight(handle.db, document, 60_000)).toBe(false);
  expect(await log.abandonSends(handle.db, document)).toBe(1);
  expect(await log.abandonSends(handle.db, document)).toBe(0);
  expect(await attempt(open)).toMatchObject({ outcome: 'ABANDONED' });
});

it('list ordena por started_at DESC e id, con sus mensajes y sin la respuesta cruda', async () => {
  const first = await log.start(handle.db, s.tenant, document, 'RECEPTION', 'TEST');
  await log.completeReception(handle.db, first, 'RETURNED', returned);
  const second = await log.start(handle.db, s.tenant, document, 'AUTHORIZATION', 'TEST');
  await handle.pgc.query(
    "UPDATE sri_attempts SET started_at = '2026-10-19 10:00:00.123456+00' WHERE id = $1",
    [first],
  );
  await handle.pgc.query("UPDATE sri_attempts SET started_at = '2026-10-20 10:00:00+00' WHERE id = $1", [second]);

  const list = await log.list(handle.db, s.tenant, document);

  expect(list.map((a) => a.id)).toEqual([second, first]);
  expect(list[0]).toEqual({
    id: second,
    operation: 'AUTHORIZATION',
    outcome: null,
    sriStatus: null,
    httpStatus: null,
    startedAt: '2026-10-20T10:00:00Z',
    completedAt: null,
    messages: [],
  });
  expect(list[1]).toMatchObject({
    operation: 'RECEPTION',
    outcome: 'RETURNED',
    sriStatus: 'DEVUELTA',
    httpStatus: 200,
    startedAt: '2026-10-19T10:00:00.123456Z',
    messages: [
      { identifier: '35', message: 'DOCUMENTO INVÁLIDO', additionalInfo: 'detalle', type: 'ERROR' },
      { identifier: '43', message: 'CLAVE ACCESO REGISTRADA', additionalInfo: null, type: 'ERROR' },
    ],
  });
  expect(list[1]!.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  expect(JSON.stringify(list)).not.toContain('respuesta');
});

it('list con la empresa de otra está vacío, y no se abre un intento con un documento ajeno', async () => {
  await log.start(handle.db, s.tenant, document, 'RECEPTION', 'TEST');
  const other = await newScenario(handle.pgc);
  expect(await log.list(handle.db, other.tenant, document)).toEqual([]);
  await expect(log.start(handle.db, other.tenant, document, 'RECEPTION', 'TEST')).rejects.toMatchObject({
    code: '23503',
  });
});

/** Los valores del histograma, con el nombre de cada serie (_count, _sum, _bucket). */
async function histogram(registry: Registry) {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === 'einvoice_sri_calls_seconds')!;
  return metric.values as Array<{ metricName?: string; labels: Record<string, string | number>; value: number }>;
}

it('al cerrar un intento se registra su duración por operación, ambiente y resultado', async () => {
  const id = await log.start(handle.db, s.tenant, document, 'RECEPTION', 'TEST');
  await log.completeReception(handle.db, id, 'RECEIVED', { ...returned, outcome: 'RECEIVED', messages: [] });
  const count = (await histogram(registry)).find(
    (v) =>
      v.metricName === 'einvoice_sri_calls_seconds_count' &&
      v.labels.operation === 'RECEPTION' &&
      v.labels.environment === '1' &&
      v.labels.outcome === 'RECEIVED',
  );
  expect(count?.value).toBe(1);
  // Un cierre que no ocurre no cuenta.
  await log.completeReception(handle.db, id, 'RECEIVED', returned);
  const again = (await histogram(registry)).find((v) => v.metricName === 'einvoice_sri_calls_seconds_count' && v.labels.outcome === 'RECEIVED');
  expect(again?.value).toBe(1);
});
