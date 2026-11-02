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

/** 11 menos el resto del módulo 11, antes de convertir 11 en 0 y 10 en 1. */
function rawCheckDigit(base48: string): number {
  let sum = 0;
  let factor = 2;
  for (let i = base48.length - 1; i >= 0; i--) {
    sum += Number(base48[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  return 11 - (sum % 11);
}

it('el golden trae casos', () => {
  expect(cases.length).toBeGreaterThan(5);
});

it('el golden cubre los dos casos especiales del módulo 11: 11 da 0 y 10 da 1', () => {
  const special = cases.filter((c) => rawCheckDigit(c.base48) >= 10);
  expect(special.filter((c) => rawCheckDigit(c.base48) === 11).map((c) => c.accessKey.at(-1))).toContain('0');
  expect(special.filter((c) => rawCheckDigit(c.base48) === 10).map((c) => c.accessKey.at(-1))).toContain('1');
  for (const c of special) expect(c.accessKey.at(-1)).toBe(rawCheckDigit(c.base48) === 11 ? '0' : '1');
});

it.each(cases.map((c) => [c.accessKey, c] as const))('%s', (_key, c) => {
  const parts = new AccessKeyParts(c);
  expect(parts.toBase48()).toBe(c.base48);
  expect(parts.toAccessKey()).toBe(c.accessKey);
  expect(buildAccessKey(c.base48)).toBe(c.accessKey);
  expect(isValidAccessKey(c.accessKey)).toBe(true);
});
