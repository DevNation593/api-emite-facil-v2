import { BigDecimal } from '../../../src/common/big-decimal.js';
import {
  calculateInvoice,
  InvalidLineError,
  type InvoiceLineInput,
} from '../../../src/billing/invoice-calculator.js';

// Traducción de TaxRoundingTest: reglas de la ficha técnica v2.34, 9.16 (tabla 21) y 9.17.
const d = (text: string) => BigDecimal.of(text);
const line = (
  quantity: string,
  unitPrice: string,
  discount: string,
  rateCode: string,
  rate: string,
): InvoiceLineInput => ({
  quantity: d(quantity),
  unitPrice: d(unitPrice),
  discount: d(discount),
  ivaRateCode: rateCode,
  ivaRate: d(rate),
});
const text = (value: BigDecimal) => value.toString();

it('una línea al 15 %', () => {
  const totals = calculateInvoice([line('2', '10.00', '0', '4', '15')]);
  expect(totals.lines.map((l) => [text(l.subtotal), text(l.taxAmount)])).toEqual([['20.00', '3.00']]);
  expect(text(totals.subtotal)).toBe('20.00');
  expect(text(totals.totalDiscount)).toBe('0.00');
  expect(totals.taxes).toHaveLength(1);
  const [tax] = totals.taxes;
  expect([tax.taxCode, tax.rateCode, text(tax.rate), text(tax.base), text(tax.amount)]).toEqual([
    '2',
    '4',
    '15',
    '20.00',
    '3.00',
  ]);
  expect(text(totals.totalTax)).toBe('3.00');
  expect(text(totals.total)).toBe('23.00');
});

it('el IVA se calcula sobre la base del grupo, no por línea', () => {
  const cheap = line('1', '0.03', '0', '4', '15');
  const totals = calculateInvoice([cheap, cheap, cheap]);
  expect(totals.lines.map((l) => text(l.taxAmount))).toEqual(['0.00', '0.00', '0.00']);
  expect(text(totals.taxes[0].base)).toBe('0.09');
  expect(text(totals.taxes[0].amount)).toBe('0.01');
  expect(text(totals.total)).toBe('0.10');
});

it('tres líneas de 0.10 al 15 %: 0.02 por línea y 0.05 sobre la base 0.30', () => {
  const three = calculateInvoice([
    line('1', '0.10', '0', '4', '15.00'),
    line('1', '0.10', '0', '4', '15.00'),
    line('1', '0.10', '0', '4', '15.00'),
  ]);
  expect(three.lines.map((l) => text(l.taxAmount))).toEqual(['0.02', '0.02', '0.02']);
  expect(text(three.taxes[0].amount)).toBe('0.05');
  expect(text(three.total)).toBe('0.35');
});

it('medio centavo redondea hacia arriba', () => {
  expect(text(calculateInvoice([line('1', '0.005', '0', '0', '0')]).subtotal)).toBe('0.01');
  expect(text(calculateInvoice([line('1', '0.004999', '0', '0', '0')]).subtotal)).toBe('0.00');
});

it('cantidad y precio de seis decimales', () => {
  const totals = calculateInvoice([line('1.234567', '9.876543', '0', '2', '12')]);
  expect(text(totals.subtotal)).toBe('12.19');
  expect(text(totals.totalTax)).toBe('1.46');
  expect(text(totals.total)).toBe('13.65');
});

it('el descuento reduce la base', () => {
  const totals = calculateInvoice([line('3', '10.00', '5.00', '4', '15')]);
  expect(text(totals.subtotal)).toBe('25.00');
  expect(text(totals.totalDiscount)).toBe('5.00');
  expect(text(totals.totalTax)).toBe('3.75');
  expect(text(totals.total)).toBe('28.75');
});

it('un descuento igual al importe de la línea da cero', () => {
  const totals = calculateInvoice([line('1', '10.00', '10.00', '4', '15')]);
  expect([totals.subtotal, totals.totalTax, totals.total].map(text)).toEqual(['0.00', '0.00', '0.00']);
});

it('tarifas mezcladas se agrupan y ordenan por código numérico', () => {
  const totals = calculateInvoice([
    line('1', '100.00', '0', '4', '15'),
    line('1', '50.00', '0', '0', '0'),
    line('2', '10.00', '0', '4', '15'),
    line('1', '20.00', '0', '10', '13'),
  ]);
  expect(totals.taxes.map((t) => [t.taxCode, t.rateCode, text(t.rate), text(t.base), text(t.amount)])).toEqual([
    ['2', '0', '0', '50.00', '0.00'],
    ['2', '4', '15', '120.00', '18.00'],
    ['2', '10', '13', '20.00', '2.60'],
  ]);
  expect(text(totals.subtotal)).toBe('190.00');
  expect(text(totals.totalTax)).toBe('20.60');
  expect(text(totals.total)).toBe('210.60');
});

it('los códigos con tarifa cero no producen impuesto', () => {
  const totals = calculateInvoice([
    line('1', '10.00', '0', '0', '0'),
    line('1', '10.00', '0', '6', '0'),
    line('1', '10.00', '0', '7', '0'),
  ]);
  expect(totals.taxes).toHaveLength(3);
  expect(text(totals.totalTax)).toBe('0.00');
  expect(text(totals.total)).toBe('30.00');
});

it('rechaza líneas inválidas con el mensaje de Java', () => {
  expect(() => calculateInvoice([])).toThrow(new InvalidLineError('La factura necesita al menos una línea'));
  const invalid: [InvoiceLineInput, string][] = [
    [line('0', '10.00', '0', '4', '15'), 'La cantidad debe ser mayor que cero'],
    [line('-1', '10.00', '0', '4', '15'), 'La cantidad debe ser mayor que cero'],
    [line('1', '-0.01', '0', '4', '15'), 'El precio unitario no puede ser negativo'],
    [line('1', '10.00', '-0.01', '4', '15'), 'El descuento no puede ser negativo'],
    [line('1', '10.00', '10.01', '4', '15'), 'El descuento no puede superar el importe de la línea'],
    [line('1', '10.00', '0', '4', '-1'), 'La tarifa de IVA no es válida'],
  ];
  for (const [input, message] of invalid) {
    expect(() => calculateInvoice([input])).toThrow(InvalidLineError);
    expect(() => calculateInvoice([input])).toThrow(message);
  }
});

it('los resultados siempre llevan dos decimales', () => {
  const totals = calculateInvoice([line('1.5', '3.333333', '0.1', '4', '15'), line('7', '0.1', '0', '5', '5')]);
  for (const value of [totals.subtotal, totals.totalDiscount, totals.totalTax, totals.total]) {
    expect(value.scale).toBe(2);
  }
  for (const amounts of totals.lines) {
    expect(amounts.subtotal.scale).toBe(2);
    expect(amounts.taxAmount.scale).toBe(2);
  }
  for (const tax of totals.taxes) {
    expect(tax.base.scale).toBe(2);
    expect(tax.amount.scale).toBe(2);
  }
  expect(text(totals.total)).toBe(text(totals.subtotal.add(totals.totalTax)));
});
