import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { DocumentPipeline } from '../../../src/orchestration/document-pipeline.js';
import { runFlyway, startStack, type StackHandle } from '../../support/containers.js';
import {
  billingScenario,
  invoiceJson,
  issueInvoice,
  processDocument,
  uploadTestCertificate,
  type BillingScenario,
} from '../../support/scenario.js';
import { SriStub, sriTestEnv } from '../../support/sri-stub.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

/*
 * Traducción de recovery/RecoveryIT.java: respaldo y restauración con las mismas órdenes que infra/backup, sobre
 * comprobantes autorizados con el SRI simulado. Lo restaurado conserva los comprobantes, sus artefactos con su
 * huella, las defensas de la base y la numeración. Las órdenes corren dentro del contenedor de PostgreSQL, como
 * en Java. test/integration/database/restore.int.spec.ts cubre aparte el esquema propio (BACKUP_SCHEMA) y la
 * negativa a escribir sobre una base con tablas; aquí no se repite.
 */
let stack: StackHandle;
let sri: SriStub;
let testApp: TestApp;
let db: pg.Client;

beforeAll(async () => {
  stack = await startStack();
  sri = await SriStub.start();
  testApp = await startTestApp(stack, sriTestEnv(sri));
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await sri?.close();
  await stack?.stop();
});

const postgres = () => stack.containers.postgres;
const user = () => postgres().getUsername();
const database = () => postgres().getDatabase();

async function exec(command: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; output: string }> {
  const result = await postgres().exec(command, { env });
  return { exitCode: result.exitCode, output: result.output };
}

async function execOk(command: string[]): Promise<void> {
  const result = await exec(command);
  expect(result.exitCode, `${command.join(' ')}\n${result.output}`).toBe(0);
}

/** Una conexión a otra base del mismo servidor. */
async function connectTo(name: string): Promise<pg.Client> {
  const url = new URL(stack.databaseUrl);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

async function authorizedInvoice(s: BillingScenario, quantity: string, amount: string): Promise<string> {
  const document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, quantity, amount));
  const pipeline = testApp.app.get(DocumentPipeline);
  let state = '';
  for (let step = 0; step < 10 && state !== 'AUTHORIZED'; step++) state = await pipeline.advance(s.tenant, document);
  expect(state).toBe('AUTHORIZED');
  return document;
}

/** Huella del contenido de una tabla para una empresa: igual en origen y destino si nada se perdió. */
async function digest(client: pg.Client, table: string, order: string, tenant: string): Promise<string> {
  const result = await client.query<{ d: string }>(
    `SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY ${order})), 'vacía') AS d FROM ${table} t WHERE tenant_id = $1`,
    [tenant],
  );
  return result.rows[0]!.d;
}

const RESTORE_SCRIPT = path.resolve('infra/backup/restore.sh');

it('theRestoreScriptFailsWhenWhatItRestoredDoesNotMatchItsHashes', async () => {
  const s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  const document = await authorizedInvoice(s, '2', '23.00');
  const artifact = (
    await db.query<{ id: string }>('SELECT id FROM document_artifacts WHERE document_id = $1 LIMIT 1', [document])
  ).rows[0]!.id;
  const restoredName = `alterada_${randomUUID().replaceAll('-', '')}`;
  // Un respaldo tomado de una base en la que alguien ya había alterado un artefacto.
  await db.query('ALTER TABLE document_artifacts DISABLE TRIGGER document_artifacts_immutable');
  try {
    await db.query("UPDATE document_artifacts SET content = content || '\\x20'::bytea WHERE id = $1", [artifact]);
    await execOk(['pg_dump', '-U', user(), '-Fc', '-f', `/tmp/${restoredName}.dump`, database()]);
  } finally {
    await db.query('UPDATE document_artifacts SET content = substring(content FROM 1 FOR length(content) - 1) WHERE id = $1', [
      artifact,
    ]);
    await db.query('ALTER TABLE document_artifacts ENABLE TRIGGER document_artifacts_immutable');
  }
  await execOk(['createdb', '-U', user(), restoredName]);
  await postgres().copyFilesToContainer([{ source: RESTORE_SCRIPT, target: '/tmp/restore.sh' }]);

  const restore = await exec([
    'env',
    `PGUSER=${user()}`,
    'bash',
    '-c',
    `cd /tmp && sha256sum ${restoredName}.dump > ${restoredName}.dump.sha256 && bash /tmp/restore.sh /tmp/${restoredName}.dump ${restoredName}`,
  ]);

  // Lo restaura (para poder examinarlo) pero no lo da por bueno.
  expect(restore.output).toMatch(/artefactos cuya huella no coincide: [1-9]/);
  expect(restore.exitCode, restore.output).not.toBe(0);
}, 120_000);

it('aRestoredBackupKeepsDocumentsArtifactsDefencesAndNumbering', async () => {
  const s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  await authorizedInvoice(s, '2', '23.00');
  const last = await authorizedInvoice(s, '1', '11.50');
  // Y uno firmado que aún no se envió.
  const signedOnly = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '1', '11.50'));
  expect(await processDocument(testApp.app, s.tenant, signedOnly)).toBe('SIGNED');

  const restoredName = `restaurada_${randomUUID().replaceAll('-', '')}`;
  await execOk(['pg_dump', '-U', user(), '-Fc', '-f', `/tmp/${restoredName}.dump`, database()]);
  await execOk(['createdb', '-U', user(), restoredName]);
  await execOk(['pg_restore', '-U', user(), '--no-owner', '--exit-on-error', '-d', restoredName, `/tmp/${restoredName}.dump`]);

  const restored = await connectTo(restoredName);
  try {
    // Nada de la empresa se perdió ni cambió.
    for (const [table, order] of [
      ['taxpayers', 'id'],
      ['certificates', 'id'],
      ['fiscal_documents', 'id'],
      ['fiscal_document_lines', 'id'],
      ['state_events', 'id'],
      ['audit_events', 'id'],
      ['document_sequences', 'emission_point_id'],
    ] as const) {
      const original = await digest(db, table, order, s.tenant);
      expect(original, table).not.toBe('vacía');
      expect(await digest(restored, table, order, s.tenant), table).toBe(original);
    }

    // Cada artefacto está y su contenido sigue correspondiendo a su huella.
    const original = (
      await db.query<{ a: string }>(
        "SELECT kind || ':' || sha256 AS a FROM document_artifacts WHERE document_id = $1 ORDER BY kind",
        [last],
      )
    ).rows.map((r) => r.a);
    expect(original.length).toBeGreaterThanOrEqual(3);
    const copied = (
      await restored.query<{ a: string }>(
        "SELECT kind || ':' || encode(sha256(content), 'hex') AS a FROM document_artifacts WHERE document_id = $1 ORDER BY kind",
        [last],
      )
    ).rows.map((r) => r.a);
    expect(copied).toEqual(original);
    const signedArtifacts = async (client: pg.Client, hash: string) =>
      (
        await client.query<{ a: string }>(
          `SELECT kind || ':' || ${hash} AS a FROM document_artifacts WHERE document_id = $1 ORDER BY kind`,
          [signedOnly],
        )
      ).rows.map((r) => r.a);
    expect(await signedArtifacts(restored, "encode(sha256(content), 'hex')")).toEqual(await signedArtifacts(db, 'sha256'));
    expect((await signedArtifacts(db, 'sha256')).map((a) => a.split(':')[0])).toEqual(['XML_SIGNED', 'XML_UNSIGNED']);

    // Las defensas de la base viajan con el respaldo.
    await expect(restored.query('UPDATE document_artifacts SET sha256 = sha256 WHERE document_id = $1', [last])).rejects.toThrow(
      'solo inserción',
    );
    await expect(restored.query('DELETE FROM document_artifacts WHERE document_id = $1', [last])).rejects.toThrow(
      'solo inserción',
    );
    await expect(restored.query('DELETE FROM audit_events WHERE tenant_id = $1', [s.tenant])).rejects.toThrow(
      'solo inserción',
    );
    await expect(
      restored.query("UPDATE taxpayers SET default_environment = '2' WHERE id = $1", [s.taxpayer]),
    ).rejects.toThrow('taxpayers_production_needs_activation');

    // La numeración continúa donde quedó: el siguiente secuencial no repite ninguno.
    const next = await restored.query<{ n: string }>(
      "SELECT next_value AS n FROM document_sequences WHERE emission_point_id = $1 AND environment = '1'",
      [s.point],
    );
    const highest = await restored.query<{ n: string }>(
      'SELECT max(sequence) AS n FROM fiscal_documents WHERE emission_point_id = $1',
      [s.point],
    );
    expect(Number(next.rows[0]!.n)).toBe(Number(highest.rows[0]!.n) + 1);
  } finally {
    await restored.end();
  }

  // Y la aplicación arrancaría sobre ella: el historial de migraciones está completo (validate falla si falta una).
  const internal = new URL(stack.postgresInternalUrl);
  internal.pathname = `/${restoredName}`;
  const validated = await runFlyway(internal.toString(), stack.postgresNetwork, 'validate');
  expect(validated.exitCode, validated.output).toBe(0);
}, 180_000);
