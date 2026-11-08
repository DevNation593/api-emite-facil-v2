import { isUniqueViolation } from '../../../src/database/unique-violation.js';

it('reconoce el 23505 de la restricción pedida', () => {
  expect(isUniqueViolation({ code: '23505', constraint: 'taxpayers_ruc_key' }, 'taxpayers_ruc_key')).toBe(true);
});

it.each([
  [{ code: '23505', constraint: 'products_sku_key' }],
  [{ code: '23503', constraint: 'taxpayers_ruc_key' }],
  [new Error('taxpayers_ruc_key')],
  [null],
  ['23505'],
])('no confunde %j con una violación de taxpayers_ruc_key', (error) => {
  expect(isUniqueViolation(error, 'taxpayers_ruc_key')).toBe(false);
});
