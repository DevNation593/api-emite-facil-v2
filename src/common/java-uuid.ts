/*
 * Lectura de UUID con las dos reglas de la API Java. En la ruta y en la consulta, Spring usa
 * UUID.fromString, que admite tramos cortos o con signo ("1-2-3-4-5"). En el cuerpo, Jackson exige
 * la forma de 36 caracteres (o 24 en Base64). Las dos devuelven la forma canónica en minúsculas.
 */

const CANONICAL = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Long.parseLong(…, 16): signo opcional y al menos un dígito hexadecimal.
const HEX_LONG = /^[+-]?[0-9a-fA-F]+$/;
const LONG_MAX = (1n << 63n) - 1n;
const LONG_MIN = -(1n << 63n);

function hex(value: bigint, digits: number): string {
  return value.toString(16).padStart(digits, '0');
}

/** `Long.parseLong(text, 16)`; null si Java lanzaría NumberFormatException. */
function parseHexLong(text: string): bigint | null {
  if (!HEX_LONG.test(text)) return null;
  const negative = text.startsWith('-');
  const digits = text.replace(/^[+-]/, '');
  const value = BigInt(`0x${digits}`) * (negative ? -1n : 1n);
  return value > LONG_MAX || value < LONG_MIN ? null : value;
}

/** Como `UUID.fromString`: la forma canónica en minúsculas, o null si Java lanzaría una excepción. */
export function javaUuidFromString(text: string): string | null {
  if (text.length === 36 && CANONICAL.test(text)) return text.toLowerCase();
  // fromString1: cinco tramos separados por guiones, cada uno leído como long y enmascarado.
  if (text.length > 36) return null;
  const parts = text.split('-');
  if (parts.length !== 5) return null;
  const values = parts.map(parseHexLong);
  if (values.some((v) => v === null)) return null;
  const [a, b, c, d, e] = values as bigint[];
  const mask = (v: bigint, bits: bigint) => BigInt.asUintN(Number(bits), v);
  return [
    hex(mask(a!, 32n), 8),
    hex(mask(b!, 16n), 4),
    hex(mask(c!, 16n), 4),
    hex(mask(d!, 16n), 4),
    hex(mask(e!, 48n), 12),
  ].join('-');
}

/** Como `UUIDDeserializer` de Jackson (el texto ya recortado): forma canónica o 16 bytes en Base64. */
export function jacksonUuid(text: string): string | null {
  if (text.length === 24) {
    if (!/^[A-Za-z0-9+/]{22}==$/.test(text)) return null;
    const bytes = Buffer.from(text, 'base64');
    if (bytes.length !== 16) return null;
    const h = bytes.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return text.length === 36 && CANONICAL.test(text) ? text.toLowerCase() : null;
}
