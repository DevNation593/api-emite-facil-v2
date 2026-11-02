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
  expect(JAVA_ONLY_ERROR_CODES).toEqual(['CATALOG_CHANGED']);
});
