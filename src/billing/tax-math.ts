import { BigDecimal } from '../common/big-decimal.js';

/*
 * Redondeo de importes común a los comprobantes: dos decimales, mitad hacia arriba (ficha técnica
 * v2.34, 9.17). Lo usan la factura y la nota de débito para calcular igual (TaxMath.java).
 */

/** Redondea a centavos, mitad hacia arriba. */
export function money(value: BigDecimal): BigDecimal {
  return value.setScale(2);
}

/** Porcentaje de una base (la tarifa viene como 15 o 15.00 para 15 %), redondeado a centavos. */
export function percentage(base: BigDecimal, rate: BigDecimal): BigDecimal {
  return money(base.multiply(rate).movePointLeft(2));
}
