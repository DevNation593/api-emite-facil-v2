import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Kysely } from 'kysely';
import {
  type ProbeCase,
  type ProbeResult,
  runProbes,
  runScenario,
  type ScenarioHooks,
  sendRaw,
} from '../../tools/java-probe/probe.mjs';
import { DATABASE } from '../../src/database/database.module.js';
import type { DB } from '../../src/database/schema.js';
import { startStack, type StackHandle } from '../support/containers.js';
import { startTestApp, type TestApp } from '../support/test-app.js';

/*
 * Repite contra NestJS las peticiones con que tools/java-probe sondeó la API Java y exige la misma
 * respuesta: estado, Content-Type, Allow y cuerpo con sus propiedades en el mismo orden. Si un caso
 * difiere, se corrige NestJS, no el golden. Cada juego de casos corre sobre una base nueva, como
 * contra Java: el RUC del escenario es único en la plataforma.
 */
function replay(
  casesName: 'e2' | 'e3',
  env: Record<string, string>,
  hooksFor?: (testApp: TestApp) => ScenarioHooks,
): void {
  const cases = JSON.parse(
    readFileSync(new URL(`../../tools/java-probe/cases/${casesName}.json`, import.meta.url), 'utf8'),
  ) as ProbeCase[];
  const golden = JSON.parse(
    readFileSync(new URL(`../golden/http/${casesName}.json`, import.meta.url), 'utf8'),
  ) as { results: ProbeResult[] };

  describe(`casos de ${casesName}`, () => {
    let stack: StackHandle;
    let testApp: TestApp;
    let results: ProbeResult[];

    beforeAll(async () => {
      stack = await startStack();
      testApp = await startTestApp(stack, env);
      await testApp.app.listen(0, '127.0.0.1');
      const { port } = testApp.app.getHttpServer().address() as AddressInfo;
      const send = (request: Parameters<typeof sendRaw>[1]) => sendRaw(`http://127.0.0.1:${port}`, request);
      results = await runProbes(send, cases, await runScenario(send, hooksFor?.(testApp)));
    }, 600_000);
    afterAll(async () => {
      await testApp?.close();
      await stack?.stop();
    });

    it('el golden y los casos son los mismos', () => {
      expect(golden.results.map((r) => r.name)).toEqual(cases.map((c) => c.name));
    });

    it.each(golden.results.map((expected, i) => [expected.name, i] as const))('%s', (_name, i) => {
      const expected = golden.results[i]!;
      const actual = results[i]!;
      expect({ ...actual, body: JSON.stringify(actual.body) }).toEqual({
        ...expected,
        body: JSON.stringify(expected.body),
      });
    });
  });
}

replay('e2', {});

// Como tools/java-probe/run.mjs con Java: sin estos topes, los casos de E3 (casi todos POST de un
// mismo usuario) recibirían 429. La factura del escenario se autoriza en la base de NestJS, igual que
// el sondeo la autoriza por SQL en la de Java.
replay(
  'e3',
  { EINVOICE_RATE_LIMIT_REQUESTS: '1000000', EINVOICE_RATE_LIMIT_WRITES: '1000000' },
  (testApp) => ({
    async authorize(documentId) {
      await testApp.app
        .get<symbol, Kysely<DB>>(DATABASE)
        .updateTable('fiscal_documents')
        .set({ state: 'AUTHORIZED' })
        .where('id', '=', documentId)
        .execute();
    },
  }),
);
