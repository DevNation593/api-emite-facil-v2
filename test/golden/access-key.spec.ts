import { readFileSync } from 'node:fs';
import { buildAccessKey, isValidAccessKey } from '../../src/sequence/access-key.js';
import { AccessKeyParts } from '../../src/sequence/access-key-parts.js';

// Claves de acceso generadas con AccessKeyParts y AccessKey de Java (tools/golden-generator).
interface Case {
  issueDate: string;
  documentType: string;
  ruc: string;
  environment: string;
  establishment: string;
  emissionPoint: string;
  sequence: number;
  numericCode: string;
  emissionType: string;
  base48: string;
  accessKey: string;
}
const { cases } = JSON.parse(readFileSync(new URL('./access-key.json', import.meta.url), 'utf8')) as {
  cases: Case[];
};

it('el golden trae casos', () => {
  expect(cases.length).toBeGreaterThan(5);
});

it.each(cases.map((c) => [c.accessKey, c] as const))('%s', (_key, c) => {
  const parts = new AccessKeyParts(c);
  expect(parts.toBase48()).toBe(c.base48);
  expect(parts.toAccessKey()).toBe(c.accessKey);
  expect(buildAccessKey(c.base48)).toBe(c.accessKey);
  expect(isValidAccessKey(c.accessKey)).toBe(true);
});
