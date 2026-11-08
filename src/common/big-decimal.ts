import { Decimal } from 'decimal.js';
import { parseDecimal } from './decimals.js';

/*
 * java.math.BigDecimal para importes y cantidades: un valor exacto más su escala (la cantidad de
 * decimales), que Java conserva en cada operación y que se ve en toString(). Debajo hay un Decimal
 * propio con precisión de sobra para el rango de la API (12 enteros y 6 decimales en las entradas) y
 * redondeo HALF_UP; las operaciones que no redondean (add, subtract, multiply, movePointLeft) son
 * exactas.
 */

const Exact = Decimal.clone({
  precision: 1_000,
  rounding: Decimal.ROUND_HALF_UP,
  toExpPos: 9e15,
  toExpNeg: -9e15,
});
type Exact = InstanceType<typeof Exact>;

/** Lo que admite `new BigDecimal(String)` aquí: notación plana, con signo menos opcional. */
const PLAIN = /^-?[0-9]+(\.[0-9]+)?$/;

/** Escalas que toString sabe escribir como Java; fuera de ellas es un error del llamador. */
const MAX_SCALE = 12;

export class BigDecimal {
  static readonly ZERO = new BigDecimal(new Exact(0), 0);

  private constructor(
    private readonly value: Exact,
    readonly scale: number,
  ) {}

  /** `new BigDecimal(text)` para texto plano: la escala es la cantidad de decimales escritos. */
  static of(text: string): BigDecimal {
    if (typeof text !== 'string' || !PLAIN.test(text)) {
      throw new Error(`No es un decimal válido: ${String(text)}`);
    }
    const point = text.indexOf('.');
    return new BigDecimal(new Exact(text), point < 0 ? 0 : text.length - point - 1);
  }

  /** `Decimals.parse`: mismas reglas y mensajes que `parseDecimal`. */
  static parse(value: string, maxIntegerDigits: number, maxFractionDigits: number): BigDecimal {
    parseDecimal(value, maxIntegerDigits, maxFractionDigits);
    return BigDecimal.of(value);
  }

  /** Escala: la mayor de las dos. */
  add(other: BigDecimal): BigDecimal {
    return new BigDecimal(this.value.plus(other.value), Math.max(this.scale, other.scale));
  }

  /** Escala: la mayor de las dos. */
  subtract(other: BigDecimal): BigDecimal {
    return new BigDecimal(this.value.minus(other.value), Math.max(this.scale, other.scale));
  }

  /** Escala: la suma de las dos. */
  multiply(other: BigDecimal): BigDecimal {
    return new BigDecimal(this.value.times(other.value), this.scale + other.scale);
  }

  /** Divide por 10^n sumando n a la escala; si quedara negativa, la escala es 0 (como Java). */
  movePointLeft(n: number): BigDecimal {
    if (n === 0) return this;
    const moved = this.value.times(new Exact(10).pow(-n));
    return new BigDecimal(moved, Math.max(this.scale + n, 0));
  }

  /** `setScale(scale, RoundingMode.HALF_UP)`. */
  setScale(scale: number): BigDecimal {
    checkScale(scale);
    return new BigDecimal(this.value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP), scale);
  }

  /** `divide(divisor, scale, RoundingMode.HALF_UP)`. */
  divide(divisor: BigDecimal, scale: number): BigDecimal {
    checkScale(scale);
    if (divisor.value.isZero()) throw new Error('División por cero');
    // Con 1000 cifras significativas el cociente redondeado a `scale` decimales es el exacto para
    // operandos de este tamaño: una racha de cientos de nueves exigiría un divisor de ese orden.
    return new BigDecimal(this.value.div(divisor.value).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP), scale);
  }

  /** Compara el valor, sin mirar la escala: 2.50 y 2.5 son iguales. */
  compareTo(other: BigDecimal): -1 | 0 | 1 {
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  signum(): -1 | 0 | 1 {
    return this.value.isZero() ? 0 : this.value.isNegative() ? -1 : 1;
  }

  /** `Decimals.format`: notación plana con exactamente `scale` decimales, HALF_UP. */
  toFixed(scale: number): string {
    checkScale(scale);
    const rounded = this.value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
    // Java no tiene -0: -0.001 con dos decimales es 0.00.
    return (rounded.isZero() ? rounded.abs() : rounded).toFixed(scale);
  }

  /**
   * `BigDecimal.toString()` de Java para escalas de 0 a 12: notación plana, salvo que el exponente
   * ajustado (posición de la primera cifra) baje de -6, que Java escribe con exponente (1E-7).
   */
  toString(): string {
    if (!Number.isInteger(this.scale) || this.scale < 0 || this.scale > MAX_SCALE) {
      throw new Error(`Escala fuera del rango de la API: ${this.scale}`);
    }
    // Valor sin escala, como el BigInteger de Java: no hay -0.
    const unscaled = this.value.times(new Exact(10).pow(this.scale));
    const negative = unscaled.isNegative() && !unscaled.isZero();
    const digits = unscaled.abs().toFixed(0);
    if (this.scale === 0) return `${negative ? '-' : ''}${digits}`;
    const adjusted = digits.length - 1 - this.scale;
    let text: string;
    if (adjusted >= -6) {
      const pad = this.scale - digits.length;
      text =
        pad >= 0
          ? `0.${'0'.repeat(pad)}${digits}`
          : `${digits.slice(0, digits.length - this.scale)}.${digits.slice(digits.length - this.scale)}`;
    } else {
      text = `${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}E${adjusted}`;
    }
    return `${negative ? '-' : ''}${text}`;
  }
}

function checkScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0) throw new Error(`Escala no válida: ${scale}`);
}
