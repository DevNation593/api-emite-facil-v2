import { Decimal } from 'decimal.js';
import { AMOUNT, formatDecimal, parseDecimal, QUANTITY_OR_PRICE } from '../../../src/common/decimals.js';

// Traducción de DecimalsTest.
it('lee decimales planos', () => {
  expect(parseDecimal('0', 12, 6).equals(0)).toBe(true);
  expect(parseDecimal('10.50', 12, 6).toFixed()).toBe('10.5');
  expect(parseDecimal('0.000001', 12, 6).toFixed()).toBe('0.000001');
  expect(parseDecimal('999999999999.999999', 12, 6).toFixed()).toBe('999999999999.999999');
});

it.each([
  null,
  '',
  '-1',
  '+1',
  '1e3',
  '1E3',
  '1,5',
  ' 1',
  '1 ',
  '1.',
  '.5',
  '1.2.3',
  'abc',
  '0x10',
  '1234567890123',
  '1.1234567',
  '１２',
])('rechaza %j', (value) => {
  expect(() => parseDecimal(value as string, 12, 6)).toThrow(Error);
});

it('los límites son parámetros', () => {
  expect(parseDecimal('12.34', 2, 2).toFixed()).toBe('12.34');
  expect(() => parseDecimal('123.4', 2, 2)).toThrow(Error);
  expect(() => parseDecimal('12.345', 2, 2)).toThrow(Error);
});

it('da formato con escala fija, HALF_UP y sin exponente', () => {
  expect(formatDecimal(new Decimal('2.5'), 2)).toBe('2.50');
  expect(formatDecimal(new Decimal('1E+3'), 2)).toBe('1000.00');
  expect(formatDecimal('10.5', 6)).toBe('10.500000');
  expect(formatDecimal('0.005', 2)).toBe('0.01');
  expect(formatDecimal(0, 2)).toBe('0.00');
  expect(formatDecimal('1.5', 6)).toBe('1.500000');
  expect(formatDecimal('0.0000005', 6)).toBe('0.000001');
  expect(formatDecimal('1E+3', 2)).toBe('1000.00');
  expect(formatDecimal('123456789012345678901234567890.5', 0)).toBe('123456789012345678901234567891');
});

it('las expresiones de validación son las de Decimals.java', () => {
  expect(QUANTITY_OR_PRICE).toBe('[0-9]{1,12}(\\.[0-9]{1,6})?');
  expect(AMOUNT).toBe('[0-9]{1,12}(\\.[0-9]{1,2})?');
});
