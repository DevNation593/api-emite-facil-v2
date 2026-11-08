import { BigDecimal } from '../common/big-decimal.js';
import { IVA_TAX_CODE } from '../catalog/catalog.repository.js';
import { money, percentage } from './tax-math.js';

/*
 * Cálculo de una factura según la ficha técnica v2.34 (InvoiceCalculator.java). Los importes llevan
 * dos decimales (9.17); el IVA de cada tarifa se calcula sobre la suma de las bases de esa tarifa, no
 * sumando el IVA de cada línea (9.16, tabla 21), así que ambos pueden diferir en centavos.
 */

/** Entrada rechazada por el cálculo (IllegalArgumentException de Java). */
export class InvalidLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLineError';
  }
}

/** Una línea de factura tal como entra al cálculo. `ivaRate` es el porcentaje (15 para 15 %). */
export interface InvoiceLineInput {
  quantity: BigDecimal;
  unitPrice: BigDecimal;
  discount: BigDecimal;
  ivaRateCode: string;
  ivaRate: BigDecimal;
}

/** Importes calculados de una línea: precio total sin impuesto e IVA de la línea. */
export interface LineAmounts {
  subtotal: BigDecimal;
  taxAmount: BigDecimal;
}

/** Total de un impuesto para una tarifa: lo que va en totalConImpuestos del comprobante. */
export interface TaxTotal {
  taxCode: string;
  rateCode: string;
  rate: BigDecimal;
  base: BigDecimal;
  amount: BigDecimal;
}

/** Resultado del cálculo de una factura; `lines` sigue el orden de las líneas de entrada. */
export interface InvoiceTotals {
  lines: LineAmounts[];
  subtotal: BigDecimal;
  totalDiscount: BigDecimal;
  taxes: TaxTotal[];
  totalTax: BigDecimal;
  total: BigDecimal;
}

/** Agrupa las bases por código de tarifa y calcula el IVA de cada grupo, ordenado por código numérico. */
export function groupTaxes(
  rateByCode: Map<string, BigDecimal>,
  baseByCode: Map<string, BigDecimal>,
): TaxTotal[] {
  return [...baseByCode.entries()]
    .map(([rateCode, base]) => {
      const rate = rateByCode.get(rateCode) as BigDecimal;
      return { taxCode: IVA_TAX_CODE, rateCode, rate, base, amount: percentage(base, rate) };
    })
    .sort((a, b) => Number.parseInt(a.rateCode, 10) - Number.parseInt(b.rateCode, 10));
}

export function calculateInvoice(lines: InvoiceLineInput[]): InvoiceTotals {
  if (lines.length === 0) {
    throw new InvalidLineError('La factura necesita al menos una línea');
  }
  const amounts: LineAmounts[] = [];
  const rateByCode = new Map<string, BigDecimal>();
  const baseByCode = new Map<string, BigDecimal>();
  let subtotal = money(BigDecimal.ZERO);
  let totalDiscount = money(BigDecimal.ZERO);
  for (const line of lines) {
    const gross = validate(line);
    const lineSubtotal = money(gross.subtract(line.discount));
    amounts.push({ subtotal: lineSubtotal, taxAmount: percentage(lineSubtotal, line.ivaRate) });
    subtotal = subtotal.add(lineSubtotal);
    totalDiscount = totalDiscount.add(money(line.discount));
    if (!rateByCode.has(line.ivaRateCode)) rateByCode.set(line.ivaRateCode, line.ivaRate);
    baseByCode.set(line.ivaRateCode, (baseByCode.get(line.ivaRateCode) ?? BigDecimal.ZERO).add(lineSubtotal));
  }
  const taxes = groupTaxes(rateByCode, baseByCode);
  const totalTax = taxes.reduce((sum, tax) => sum.add(tax.amount), money(BigDecimal.ZERO));
  return { lines: amounts, subtotal, totalDiscount, taxes, totalTax, total: subtotal.add(totalTax) };
}

/** Devuelve cantidad × precio, tras comprobar que la línea es calculable. */
function validate(line: InvoiceLineInput): BigDecimal {
  if (line.quantity.signum() <= 0) {
    throw new InvalidLineError('La cantidad debe ser mayor que cero');
  }
  if (line.unitPrice.signum() < 0) {
    throw new InvalidLineError('El precio unitario no puede ser negativo');
  }
  if (line.discount.signum() < 0) {
    throw new InvalidLineError('El descuento no puede ser negativo');
  }
  if (line.ivaRate.signum() < 0) {
    throw new InvalidLineError('La tarifa de IVA no es válida');
  }
  const gross = line.quantity.multiply(line.unitPrice);
  if (line.discount.compareTo(gross) > 0) {
    throw new InvalidLineError('El descuento no puede superar el importe de la línea');
  }
  return gross;
}
