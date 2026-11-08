import type { BigDecimal } from '../common/big-decimal.js';

/**
 * Descuento de la línea original en proporción a la cantidad acreditada
 * (CreditNoteService.proratedDiscount): descuento × cantidad ÷ cantidad original, a dos decimales con
 * la mitad hacia arriba. Una nota con menos descuento que este acreditaría más que lo facturado.
 */
export function proratedDiscount(
  originalDiscount: BigDecimal,
  originalQuantity: BigDecimal,
  quantity: BigDecimal,
): BigDecimal {
  return originalDiscount.multiply(quantity).divide(originalQuantity, 2);
}
