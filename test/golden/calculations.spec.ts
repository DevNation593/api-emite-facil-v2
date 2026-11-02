import { readFileSync } from 'node:fs';
import { BigDecimal } from '../../src/common/big-decimal.js';
import { calculateInvoice, type TaxTotal } from '../../src/billing/invoice-calculator.js';
import { calculateDebitNote } from '../../src/notes/debit-note-calculator.js';
import { proratedDiscount } from '../../src/notes/prorated-discount.js';

// Importes calculados con InvoiceCalculator, DebitNoteCalculator y CreditNoteService.proratedDiscount de
// Java (tools/golden-generator, familia calculations). Cada decimal se compara con toString(), así que
// también cuenta la escala.
interface TaxCase {
  taxCode: string;
  rateCode: string;
  rate: string;
  base: string;
  amount: string;
}
interface InvoiceCase {
  lines: { quantity: string; unitPrice: string; discount: string; ivaRateCode: string; ivaRate: string }[];
  expected?: {
    lines: { subtotal: string; taxAmount: string }[];
    subtotal: string;
    totalDiscount: string;
    taxes: TaxCase[];
    totalTax: string;
    total: string;
  };
  error?: string;
}
interface DebitCase {
  inputs: { reason: string; value: string; ivaRateCode: string; ivaRate: string }[];
  expected?: {
    reasons: {
      reason: string;
      value: string;
      taxCode: string;
      taxRateCode: string;
      taxRate: string;
      taxAmount: string;
    }[];
    taxes: TaxCase[];
    subtotal: string;
    totalTax: string;
    total: string;
  };
  error?: string;
}
interface ProrationCase {
  originalDiscount: string;
  originalQuantity: string;
  quantity: string;
  expected?: string;
  error?: string;
}
const golden = JSON.parse(readFileSync(new URL('./calculations.json', import.meta.url), 'utf8')) as {
  invoices: InvoiceCase[];
  debitNotes: DebitCase[];
  proratedDiscounts: ProrationCase[];
};
const d = (text: string) => BigDecimal.of(text);
const taxes = (list: TaxTotal[]) =>
  list.map((t) => ({
    taxCode: t.taxCode,
    rateCode: t.rateCode,
    rate: t.rate.toString(),
    base: t.base.toString(),
    amount: t.amount.toString(),
  }));

describe('cálculos contra Java', () => {
  it('tiene casos de las tres familias', () => {
    expect(golden.invoices.length).toBeGreaterThanOrEqual(300);
    expect(golden.debitNotes.length).toBeGreaterThanOrEqual(100);
    expect(golden.proratedDiscounts.length).toBeGreaterThanOrEqual(100);
    expect(golden.invoices.some((c) => c.error)).toBe(true);
    expect(golden.debitNotes.some((c) => c.error)).toBe(true);
  });

  it('facturas: mismos importes y escala, o el mismo mensaje', () => {
    for (const c of golden.invoices) {
      const run = () =>
        calculateInvoice(
          c.lines.map((l) => ({
            quantity: d(l.quantity),
            unitPrice: d(l.unitPrice),
            discount: d(l.discount),
            ivaRateCode: l.ivaRateCode,
            ivaRate: d(l.ivaRate),
          })),
        );
      if (c.error !== undefined) {
        expect(run, JSON.stringify(c.lines)).toThrow(c.error);
        continue;
      }
      const got = run();
      expect(
        {
          lines: got.lines.map((l) => ({ subtotal: l.subtotal.toString(), taxAmount: l.taxAmount.toString() })),
          subtotal: got.subtotal.toString(),
          totalDiscount: got.totalDiscount.toString(),
          taxes: taxes(got.taxes),
          totalTax: got.totalTax.toString(),
          total: got.total.toString(),
        },
        JSON.stringify(c.lines),
      ).toEqual(c.expected);
    }
  });

  it('notas de débito: mismos importes y escala, o el mismo mensaje', () => {
    for (const c of golden.debitNotes) {
      const run = () =>
        calculateDebitNote(
          c.inputs.map((i) => ({
            reason: i.reason,
            value: d(i.value),
            ivaRateCode: i.ivaRateCode,
            ivaRate: d(i.ivaRate),
          })),
        );
      if (c.error !== undefined) {
        expect(run, JSON.stringify(c.inputs)).toThrow(c.error);
        continue;
      }
      const got = run();
      expect(
        {
          reasons: got.reasons.map((r) => ({
            reason: r.reason,
            value: r.value.toString(),
            taxCode: r.taxCode,
            taxRateCode: r.taxRateCode,
            taxRate: r.taxRate.toString(),
            taxAmount: r.taxAmount.toString(),
          })),
          taxes: taxes(got.taxes),
          subtotal: got.subtotal.toString(),
          totalTax: got.totalTax.toString(),
          total: got.total.toString(),
        },
        JSON.stringify(c.inputs),
      ).toEqual(c.expected);
    }
  });

  it('descuento prorrateado', () => {
    for (const c of golden.proratedDiscounts) {
      const got = proratedDiscount(d(c.originalDiscount), d(c.originalQuantity), d(c.quantity));
      expect(got.toString(), JSON.stringify(c)).toBe(c.expected);
    }
  });

  it('valores exactos', () => {
    const line = (quantity: string, unitPrice: string, discount = '0', code = '4', rate = '15.00') => ({
      quantity: d(quantity),
      unitPrice: d(unitPrice),
      discount: d(discount),
      ivaRateCode: code,
      ivaRate: d(rate),
    });
    const three = calculateInvoice([line('1', '0.10'), line('1', '0.10'), line('1', '0.10')]);
    expect(three.lines.map((l) => l.taxAmount.toString())).toEqual(['0.02', '0.02', '0.02']);
    expect(three.taxes[0].amount.toString()).toBe('0.05'); // sobre la base 0.30, no 3 × 0.02
    expect(three.total.toString()).toBe('0.35');
    expect(proratedDiscount(d('1.00'), d('3'), d('1')).toString()).toBe('0.33');
    expect(() => calculateInvoice([line('0', '1')])).toThrow('La cantidad debe ser mayor que cero');
  });
});
