import { BigDecimal } from '../../../src/common/big-decimal.js';
import { calculateInvoice, InvalidLineError } from '../../../src/billing/invoice-calculator.js';
import { calculateDebitNote, type DebitInput } from '../../../src/notes/debit-note-calculator.js';

// Traducción de DebitNoteCalculatorTest: el IVA se calcula por tarifa, igual que en la factura.
const d = (text: string) => BigDecimal.of(text);
const input = (reason: string, value: string, rateCode: string, rate: string): DebitInput => ({
  reason,
  value: d(value),
  ivaRateCode: rateCode,
  ivaRate: d(rate),
});

it('agrupa el impuesto por tarifa', () => {
  const result = calculateDebitNote([
    input('Intereses de mora', '10.00', '4', '15'),
    input('Gastos de cobranza', '5.00', '4', '15'),
    input('Servicio exento', '3.00', '0', '0'),
  ]);
  expect(result.taxes).toHaveLength(2);
  const [zero, fifteen] = result.taxes;
  expect(zero.rateCode).toBe('0');
  expect(zero.base.toString()).toBe('3.00');
  expect(zero.amount.toString()).toBe('0.00');
  expect([fifteen.taxCode, fifteen.rateCode, fifteen.rate.toString()]).toEqual(['2', '4', '15']);
  expect(fifteen.base.toString()).toBe('15.00');
  expect(fifteen.amount.toString()).toBe('2.25');
  expect(result.subtotal.toString()).toBe('18.00');
  expect(result.totalTax.toString()).toBe('2.25');
  expect(result.total.toString()).toBe('20.25');
  expect(result.reasons.map((r) => r.taxAmount.toString())).toEqual(['1.50', '0.75', '0.00']);
  expect(result.reasons[0].taxCode).toBe('2');
});

it('redondea como la factura', () => {
  const inputs = [input('a', '0.33', '4', '15'), input('b', '0.33', '4', '15'), input('c', '0.33', '4', '15')];
  const lines = inputs.map((i) => ({
    quantity: d('1'),
    unitPrice: i.value,
    discount: BigDecimal.ZERO,
    ivaRateCode: i.ivaRateCode,
    ivaRate: i.ivaRate,
  }));
  expect(calculateDebitNote(inputs).totalTax.toString()).toBe(calculateInvoice(lines).totalTax.toString());
  // 0.90 al 15 % son 0.135: se redondea hacia arriba sobre la base agrupada, no por motivo.
  const grouped = calculateDebitNote([
    input('a', '0.30', '4', '15'),
    input('b', '0.30', '4', '15'),
    input('c', '0.30', '4', '15'),
  ]);
  expect(grouped.taxes[0].amount.toString()).toBe('0.14');
  expect(grouped.totalTax.toString()).toBe('0.14');
});

it('rechaza un valor cero o negativo y la lista vacía', () => {
  expect(() => calculateDebitNote([input('a', '0.00', '4', '15')])).toThrow(InvalidLineError);
  expect(() => calculateDebitNote([input('a', '0.00', '4', '15')])).toThrow(
    'El valor del motivo debe ser mayor que cero',
  );
  expect(() => calculateDebitNote([input('a', '-1.00', '4', '15')])).toThrow(InvalidLineError);
  expect(() => calculateDebitNote([])).toThrow('La nota de débito necesita al menos un motivo');
  expect(() => calculateDebitNote([input('a', '1.00', '4', '-1')])).toThrow('La tarifa de IVA no es válida');
});
