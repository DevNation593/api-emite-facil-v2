/** Clave de acceso de 49 dígitos con dígito verificador módulo 11 (docs/06-access-key-algorithm.md). */

const BASE48 = /^[0-9]{48}$/;
const KEY = /^[0-9]{49}$/;

export function buildAccessKey(base48: string): string {
  if (typeof base48 !== 'string' || !BASE48.test(base48)) {
    throw new Error('Se requieren exactamente 48 dígitos');
  }
  let sum = 0;
  let factor = 2;
  for (let i = base48.length - 1; i >= 0; i--) {
    sum += (base48.charCodeAt(i) - 48) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  let dv = 11 - (sum % 11);
  if (dv === 11) dv = 0;
  else if (dv === 10) dv = 1;
  return `${base48}${dv}`;
}

export function isValidAccessKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && KEY.test(key) && buildAccessKey(key.slice(0, 48)) === key;
}
