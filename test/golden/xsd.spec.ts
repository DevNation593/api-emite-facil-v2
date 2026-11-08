import { readFileSync } from 'node:fs';
import { DOCUMENT_SCHEMAS } from '../../src/xml/document-type.js';
import { checkEnvelope } from '../../src/xml/envelope-rules.js';
import { XsdValidator } from '../../src/xml/xsd-validator.js';

// Validación XSD y reglas del sobre de Java (XsdValidator y EnvelopeRules) sobre los ejemplos del SRI y variantes
// de la factura estándar (tools/golden-generator, familia xsd). libxml2 no da los mensajes de Xerces: solo se compara
// si el XML es válido y qué violaciones del sobre tiene.
interface Case {
  name: string;
  file: string;
  schema: keyof typeof DOCUMENT_SCHEMAS;
  valid: boolean;
  violations: string[] | 'unreadable' | null;
}
const { cases } = JSON.parse(
  readFileSync(new URL('./xsd.json', import.meta.url), 'utf8'),
) as { cases: Case[] };
const root = new URL('../../', import.meta.url);
const validator = new XsdValidator();

it('el golden trae casos', () => {
  expect(cases.length).toBeGreaterThanOrEqual(25);
  expect(cases.some((c) => c.valid)).toBe(true);
  expect(cases.some((c) => !c.valid)).toBe(true);
});

it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
  const xml = readFileSync(new URL(c.file, root));
  const schema = DOCUMENT_SCHEMAS[c.schema];
  const result = await validator.validate(xml, schema);
  expect(result.valid).toBe(c.valid);
  expect(result.errors.length === 0).toBe(c.valid);
  if (!c.valid) {
    expect(c.violations).toBeNull();
    return;
  }
  if (c.violations === 'unreadable') {
    expect(() => checkEnvelope(xml, schema)).toThrow();
  } else {
    expect([...checkEnvelope(xml, schema)].sort()).toEqual(c.violations);
  }
});
