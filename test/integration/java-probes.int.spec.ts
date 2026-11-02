import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import {
  type ProbeCase,
  type ProbeResult,
  runProbes,
  runScenario,
  sendRaw,
} from '../../tools/java-probe/probe.mjs';
import { startStack, type StackHandle } from '../support/containers.js';
import { startTestApp, type TestApp } from '../support/test-app.js';

/*
 * Repite contra NestJS las peticiones con que tools/java-probe sondeó la API Java y exige la misma
 * respuesta: estado, Content-Type, Allow y cuerpo con sus propiedades en el mismo orden. Si un caso
 * difiere, se corrige NestJS, no el golden.
 */
const cases = JSON.parse(
  readFileSync(new URL('../../tools/java-probe/cases/e2.json', import.meta.url), 'utf8'),
) as ProbeCase[];
const golden = JSON.parse(readFileSync(new URL('../golden/http/e2.json', import.meta.url), 'utf8')) as {
  results: ProbeResult[];
};

let stack: StackHandle;
let testApp: TestApp;
let results: ProbeResult[];

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
  await testApp.app.listen(0, '127.0.0.1');
  const { port } = testApp.app.getHttpServer().address() as AddressInfo;
  const send = (request: Parameters<typeof sendRaw>[1]) => sendRaw(`http://127.0.0.1:${port}`, request);
  results = await runProbes(send, cases, await runScenario(send));
}, 300_000);
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
