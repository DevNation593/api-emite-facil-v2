import { BigDecimal } from '../common/big-decimal.js';
import { IVA_TAX_CODE } from '../catalog/catalog.repository.js';
import { groupTaxes, InvalidLineError, type TaxTotal } from '../billing/invoice-calculator.js';
import { money, percentage } from '../billing/tax-math.js';

/*
 * Cálculo de una nota de débito (DebitNoteCalculator.java). Redondea como la factura (dos decimales,
 * mitad hacia arriba): el IVA de cada tarifa se calcula sobre la suma de los valores de esa tarifa, no
 * sumando el de cada motivo.
 */

/** Impuesto agrupado de una nota: código, tarifa, base imponible y valor. */
export type NoteTax = TaxTotal;

/** Un motivo tal como entra al cálculo. `ivaRate` es el porcentaje (15 para 15 %). */
export interface DebitInput {
  reason: string;
  value: BigDecimal;
  ivaRateCode: string;
  ivaRate: BigDecimal;
}

export interface DebitReason {
  reason: string;
  value: BigDecimal;
  taxCode: string;
  taxRateCode: string;
  taxRate: BigDecimal;
  taxAmount: BigDecimal;
}

export interface DebitNoteTotals {
  reasons: DebitReason[];
  taxes: NoteTax[];
  subtotal: BigDecimal;
  totalTax: BigDecimal;
  total: BigDecimal;
}

export function calculateDebitNote(inputs: DebitInput[]): DebitNoteTotals {
  if (inputs.length === 0) {
    throw new InvalidLineError('La nota de débito necesita al menos un motivo');
  }
  const reasons: DebitReason[] = [];
  const rateByCode = new Map<string, BigDecimal>();
  const baseByCode = new Map<string, BigDecimal>();
  let subtotal = money(BigDecimal.ZERO);
  for (const input of inputs) {
    validate(input);
    const value = money(input.value);
    reasons.push({
      reason: input.reason,
      value,
      taxCode: IVA_TAX_CODE,
      taxRateCode: input.ivaRateCode,
      taxRate: input.ivaRate,
      taxAmount: percentage(value, input.ivaRate),
    });
    subtotal = subtotal.add(value);
    if (!rateByCode.has(input.ivaRateCode)) rateByCode.set(input.ivaRateCode, input.ivaRate);
    baseByCode.set(input.ivaRateCode, (baseByCode.get(input.ivaRateCode) ?? BigDecimal.ZERO).add(value));
  }
  const taxes = groupTaxes(rateByCode, baseByCode);
  const totalTax = taxes.reduce((sum, tax) => sum.add(tax.amount), money(BigDecimal.ZERO));
  return { reasons, taxes, subtotal, totalTax, total: subtotal.add(totalTax) };
}

function validate(input: DebitInput): void {
  if (input.value.signum() <= 0) {
    throw new InvalidLineError('El valor del motivo debe ser mayor que cero');
  }
  if (input.ivaRate.signum() < 0) {
    throw new InvalidLineError('La tarifa de IVA no es válida');
  }
}
