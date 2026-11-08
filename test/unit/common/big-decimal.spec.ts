import { BigDecimal } from '../../../src/common/big-decimal.js';

const bd = (text: string) => BigDecimal.of(text);

describe('BigDecimal, como java.math.BigDecimal', () => {
  it('of conserva la escala escrita, como new BigDecimal(String)', () => {
    expect(bd('2.50').toString()).toBe('2.50');
    expect(bd('2.50').scale).toBe(2);
    expect(bd('007').toString()).toBe('7');
    expect(bd('00.50').toString()).toBe('0.50');
    expect(bd('-1.5').toString()).toBe('-1.5');
    expect(bd('0.000').toString()).toBe('0.000');
    expect(bd('-0.00').toString()).toBe('0.00');
  });

  it.each(['', '1.', '.5', '+1', '1e2', '1,5', ' 1', 'NaN', 'Infinity', '--1', '0x10'])('of rechaza %j', (text) => {
    expect(() => BigDecimal.of(text)).toThrow(Error);
  });

  it('parse aplica las reglas de Decimals.parse', () => {
    expect(BigDecimal.parse('12.50', 12, 2).toString()).toBe('12.50');
    expect(BigDecimal.parse('007', 12, 6).toString()).toBe('7');
    expect(() => BigDecimal.parse('1.234', 12, 2)).toThrow('Demasiados dígitos: 1.234');
    expect(() => BigDecimal.parse('1234567890123', 12, 2)).toThrow('Demasiados dígitos: 1234567890123');
    expect(() => BigDecimal.parse('-1', 12, 2)).toThrow('No es un decimal válido: -1');
    expect(() => BigDecimal.parse('1e2', 12, 2)).toThrow('No es un decimal válido: 1e2');
  });

  it('las operaciones fijan la escala como Java', () => {
    expect(bd('1.5').multiply(bd('9.333333')).toString()).toBe('13.9999995');
    expect(bd('13.9999995').setScale(2).toString()).toBe('14.00');
    expect(bd('1.00').multiply(bd('1')).divide(bd('3'), 2).toString()).toBe('0.33');
    expect(bd('23.00').subtract(bd('0')).toString()).toBe('23.00');
    expect(bd('0.30').multiply(bd('15.00')).movePointLeft(2).setScale(2).toString()).toBe('0.05');
    expect(bd('1.1').add(bd('2.25')).toString()).toBe('3.35');
    expect(bd('5').add(bd('0.000')).toString()).toBe('5.000');
    expect(bd('1.23').subtract(bd('2')).toString()).toBe('-0.77');
    expect(BigDecimal.ZERO.toString()).toBe('0');
    expect(BigDecimal.ZERO.scale).toBe(0);
  });

  it('setScale y divide redondean HALF_UP, también en negativos', () => {
    expect(bd('0.125').setScale(2).toString()).toBe('0.13');
    expect(bd('0.124').setScale(2).toString()).toBe('0.12');
    expect(bd('-0.125').setScale(2).toString()).toBe('-0.13');
    expect(bd('2').setScale(3).toString()).toBe('2.000');
    expect(bd('2').divide(bd('3'), 2).toString()).toBe('0.67');
    expect(bd('-2').divide(bd('3'), 2).toString()).toBe('-0.67');
    expect(bd('1').divide(bd('8'), 2).toString()).toBe('0.13');
    expect(bd('10').divide(bd('4'), 0).toString()).toBe('3');
    expect(() => bd('1').divide(BigDecimal.ZERO, 2)).toThrow(Error);
  });

  it('movePointLeft suma a la escala y no la deja negativa', () => {
    expect(bd('12').movePointLeft(2).toString()).toBe('0.12');
    expect(bd('12.5').movePointLeft(0).toString()).toBe('12.5');
    expect(bd('12.5').movePointLeft(-3).toString()).toBe('12500');
  });

  it('compareTo y signum ignoran la escala', () => {
    expect(bd('2.50').compareTo(bd('2.5'))).toBe(0);
    expect(bd('2.49').compareTo(bd('2.5'))).toBe(-1);
    expect(bd('3').compareTo(bd('2.999999'))).toBe(1);
    expect(bd('0.00').signum()).toBe(0);
    expect(bd('-0.01').signum()).toBe(-1);
    expect(bd('7').signum()).toBe(1);
  });

  it('es inmutable', () => {
    const value = bd('1.50');
    value.add(bd('1')).setScale(4).movePointLeft(1);
    expect(value.toString()).toBe('1.50');
  });

  it('toString es el de Java hasta la escala 12, con exponente si el exponente ajustado baja de -6', () => {
    expect(bd('0.000001').toString()).toBe('0.000001');
    expect(bd('0.0000001').toString()).toBe('1E-7');
    expect(bd('0.00000010').toString()).toBe('1.0E-7');
    expect(bd('0.0000000').toString()).toBe('0E-7');
    expect(bd('-0.000000123').toString()).toBe('-1.23E-7');
    expect(bd('0.000001').multiply(bd('0.000001')).toString()).toBe('1E-12');
    expect(bd('123456789012.123456').toString()).toBe('123456789012.123456');
    expect(bd('123456789012345678901234567890').toString()).toBe('123456789012345678901234567890');
  });

  it('toString lanza fuera de la escala 0 a 12', () => {
    expect(() => bd('0.1234567').multiply(bd('0.123456')).toString()).toThrow(Error);
    expect(() => bd('1.0000000000000').toString()).toThrow(Error);
  });

  it('toFixed es Decimals.format: notación plana con la escala pedida y HALF_UP', () => {
    expect(bd('13.9999995').toFixed(2)).toBe('14.00');
    expect(bd('2.5').toFixed(0)).toBe('3');
    expect(bd('7').toFixed(6)).toBe('7.000000');
    expect(bd('0.0000001').toFixed(7)).toBe('0.0000001');
    expect(bd('0.1234567').multiply(bd('0.123456')).toFixed(2)).toBe('0.02');
    expect(bd('-0.001').toFixed(2)).toBe('0.00');
    expect(bd('-0.001').setScale(2).toString()).toBe('0.00');
  });
});
