#!/usr/bin/env node
// Sondea la API Java por HTTP y guarda lo que responde en test/golden/http/<casos>.json. Fija lo
// que el código no dice a simple vista: coerciones de Jackson, conversión de parámetros de Spring,
// orden de propiedades y nulos. Uso:
//   node tools/java-probe/run.mjs --java-repo ../backend-emite-facil [--skip-build] --cases e2
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { fail, javaArguments, javaSource, runTool, startJavaApp } from '../java-dump/java-app.mjs';
import { runProbes, runScenario, SEEDED_ATTEMPTS, sendRaw } from './probe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(resolve(here, '..', '..'), 'test', 'golden', 'http');

await runTool('java-probe', async (step, onFailure) => {
  step('argumentos');
  const argv = process.argv.slice(2);
  const { javaRepo, skipBuild } = javaArguments(argv);
  const casesFlag = argv.indexOf('--cases');
  const casesName = casesFlag === -1 ? undefined : argv[casesFlag + 1];
  if (casesName === undefined || !/^[a-z0-9-]+$/.test(casesName)) fail('falta --cases <nombre>, p. ej. --cases e2');
  const cases = JSON.parse(readFileSync(join(here, 'cases', `${casesName}.json`), 'utf8'));
  const names = new Set();
  for (const probe of cases) {
    if (names.has(probe.name)) fail(`caso repetido: ${probe.name}`);
    names.add(probe.name);
  }
  step('commit del repo Java');
  const source = javaSource(javaRepo);

  // Los 552 casos de E3 son casi todos escrituras de un mismo usuario: con el tope por defecto (300
  // por minuto) Java respondería 429 a la mitad. El tope se sube; el 429 ya lo cubre otra prueba.
  const env = { EINVOICE_RATE_LIMIT_REQUESTS: '1000000', EINVOICE_RATE_LIMIT_WRITES: '1000000' };
  const app = await startJavaApp({ javaRepo, skipBuild, env, step, onFailure });
  try {
    const send = (request) => sendRaw(app.base, request);
    step('crear el escenario');
    // E3 parte de una factura autorizada: sin SRI ni worker, Java la deja en RESERVED, así que se
    // autoriza por SQL para que las notas la acepten.
    const withDb = async (work) => {
      const db = new pg.Client({ connectionString: app.postgres.getConnectionUri() });
      await db.connect();
      try {
        return await work(db);
      } finally {
        await db.end();
      }
    };
    const hooks = {
      authorize: (documentId) =>
        withDb((db) => db.query("UPDATE fiscal_documents SET state = 'AUTHORIZED' WHERE id = $1", [documentId])),
      // E4: sin worker ni SRI, los comprobantes no pasan de RESERVED; el resto se siembra por SQL.
      setState: (documentId, state) =>
        withDb((db) => db.query('UPDATE fiscal_documents SET state = $2 WHERE id = $1', [documentId, state])),
      addMember: (tenantId, email, role) =>
        withDb((db) =>
          db.query(
            `INSERT INTO memberships (user_id, tenant_id, role)
             SELECT id, $1, $3 FROM users WHERE email = $2`,
            [tenantId, email, role],
          ),
        ),
      seedAttempts: (documentId) =>
        withDb(async (db) => {
          const owner = await db.query('SELECT tenant_id FROM fiscal_documents WHERE id = $1', [documentId]);
          const tenantId = owner.rows[0].tenant_id;
          for (const attempt of SEEDED_ATTEMPTS) {
            // El instante sembrado ya trae sus decimales: se inserta tal cual, sin pasar por Date.
            const inserted = await db.query(
              `INSERT INTO sri_attempts (tenant_id, document_id, operation, environment, started_at, completed_at,
                 outcome, sri_status, http_status, error_detail, response)
               VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, $10, $11) RETURNING id`,
              [
                tenantId,
                documentId,
                attempt.operation,
                attempt.environment,
                attempt.startedAt,
                attempt.completedAt,
                attempt.outcome,
                attempt.sriStatus,
                attempt.httpStatus,
                attempt.errorDetail,
                attempt.response === null ? null : Buffer.from(attempt.response, 'utf8'),
              ],
            );
            for (const [index, message] of attempt.messages.entries()) {
              await db.query(
                `INSERT INTO sri_messages (attempt_id, position, identifier, message, additional_info, type)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [inserted.rows[0].id, index + 1, message.identifier, message.message, message.additionalInfo, message.type],
              );
            }
          }
        }),
    };
    const scenario = await runScenario(send, casesName === 'e2' ? undefined : casesName === 'e3' ? { authorize: hooks.authorize } : hooks);
    step(`ejecutar ${cases.length} casos`);
    const results = await runProbes(send, cases, scenario);
    const errors = results.filter((result) => result.status >= 500).map((result) => result.name);
    if (errors.length > 0) fail(`Java respondió 5xx en: ${errors.join(', ')}`);
    const limited = results.filter((result) => result.status === 429).map((result) => result.name);
    if (limited.length > 0) fail(`Java respondió 429 (límite de peticiones) en: ${limited.slice(0, 5).join(', ')}`);

    step('escribir el golden');
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${casesName}.json`);
    writeFileSync(
      file,
      `${JSON.stringify({ source: { ...source, generatedAt: new Date().toISOString() }, results }, null, 2)}\n`,
    );
    console.log(`[java-probe] listo: ${file}`);
  } finally {
    await app.stop();
  }
});
