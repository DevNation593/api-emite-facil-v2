import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { ERROR_CODES, JAVA_ONLY_ERROR_CODES } from '../../../src/common/error-codes.js';

it('cubre el enum errorCode de contracts/openapi.yaml', () => {
  const contract = parse(readFileSync('contracts/openapi.yaml', 'utf8')) as {
    components: {
      schemas: { Problem: { properties: { errorCode: { enum: string[] } } } };
    };
  };
  const expected = contract.components.schemas.Problem.properties.errorCode.enum;
  expect(expected.length).toBeGreaterThan(50);
  for (const code of expected) {
    expect(ERROR_CODES as readonly string[]).toContain(code);
  }
});

it('fuera del contrato solo quedan los códigos que Java devuelve sin declararlos', () => {
  const contract = parse(readFileSync('contracts/openapi.yaml', 'utf8')) as {
    components: {
      schemas: { Problem: { properties: { errorCode: { enum: string[] } } } };
    };
  };
  const declared = new Set(contract.components.schemas.Problem.properties.errorCode.enum);
  const extra = (ERROR_CODES as readonly string[]).filter((code) => !declared.has(code));
  expect(extra).toEqual([...JAVA_ONLY_ERROR_CODES]);
  expect(JAVA_ONLY_ERROR_CODES).toEqual([
    'CATALOG_CHANGED',
    'DOCUMENT_XML_INVALID',
    'REPLACED_DOCUMENT_OTHER_TYPE',
    'MODIFIED_DOCUMENT_REQUIRED',
    'MODIFIED_DOCUMENT_NOT_INVOICE',
    'MODIFIED_INVOICE_OTHER_ISSUER',
    'MODIFIED_INVOICE_NOT_AUTHORIZED',
    'INVALID_MODIFIED_DOCUMENT_DATE',
    'CREDIT_LINE_UNKNOWN',
    'CREDIT_LINE_EXCEEDS_INVOICE',
    'CREDIT_EXCEEDS_INVOICE',
  ]);
});

it('todo errorCode que Java devolvió en los sondeos está en la lista', () => {
  for (const file of ['e2.json', 'e3.json']) {
    const { results } = JSON.parse(readFileSync(`test/golden/http/${file}`, 'utf8')) as {
      results: Array<{ body: { errorCode?: string } | null }>;
    };
    for (const { body } of results) {
      if (typeof body?.errorCode === 'string') expect(ERROR_CODES as readonly string[]).toContain(body.errorCode);
    }
  }
});
