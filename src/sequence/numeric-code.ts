import { randomInt } from 'node:crypto';

/** Código numérico de 8 dígitos de la clave de acceso; se genera una vez y se persiste. */
export function nextNumericCode(): string {
  return String(randomInt(100_000_000)).padStart(8, '0');
}
