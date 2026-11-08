import { Decimal } from 'decimal.js';

/**
 * Importes y cantidades viajan en JSON como cadenas decimales para no perder precisión
 * (docs/11-api-specification.md). Aquí se convierten desde y hacia Decimal, como Decimals.java.
 */

/** Para `@Pattern`: cantidad o precio unitario, hasta 12 enteros y 6 decimales. */
export const QUANTITY_OR_PRICE = '[0-9]{1,12}(\\.[0-9]{1,6})?';

/** Para `@Pattern`: importe, hasta 12 enteros y 2 decimales. */
export const AMOUNT = '[0-9]{1,12}(\\.[0-9]{1,2})?';

const PLAIN = /^[0-9]+(\.[0-9]+)?$/;

// Un Decimal propio: precisión de sobra para 12 enteros y 6 decimales, y redondeo HALF_UP.
const Exact = Decimal.clone({ precision: 1_000, rounding: Decimal.ROUND_HALF_UP, toExpPos: 9e15, toExpNeg: -9e15 });

/** Solo dígitos con punto decimal opcional: sin signo, exponente, comas ni espacios. */
export function parseDecimal(value: string, maxIntegerDigits: number, maxFractionDigits: number): Decimal {
  if (typeof value !== 'string' || !PLAIN.test(value)) {
    throw new Error(`No es un decimal válido: ${String(value)}`);
  }
  const point = value.indexOf('.');
  const integerDigits = point < 0 ? value.length : point;
  const fractionDigits = point < 0 ? 0 : value.length - point - 1;
  if (integerDigits > maxIntegerDigits || fractionDigits > maxFractionDigits) {
    throw new Error(`Demasiados dígitos: ${value}`);
  }
  return new Exact(value);
}

/** Notación plana con exactamente `scale` decimales, redondeando HALF_UP. */
export function formatDecimal(value: Decimal.Value, scale: number): string {
  return new Exact(value).toFixed(scale, Decimal.ROUND_HALF_UP);
}
