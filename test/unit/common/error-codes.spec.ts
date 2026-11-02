import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { ERROR_CODES } from '../../../src/common/error-codes.js';

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
