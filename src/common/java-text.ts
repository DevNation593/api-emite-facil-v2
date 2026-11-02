/**
 * Caracteres que `Character.isWhitespace` de Java da por espacio. Excluye los espacios
 * de no ruptura (U+00A0, U+2007, U+202F) y U+0085, a diferencia de `\s` y `trim()` de JS.
 */
const JAVA_WHITESPACE =
  '\\t\\n\\u000B\\f\\r\\u001C-\\u001F \\u1680\\u2000-\\u2006\\u2008-\\u200A\\u2028\\u2029\\u205F\\u3000';
const LEADING = new RegExp(`^[${JAVA_WHITESPACE}]+`);
const TRAILING = new RegExp(`[${JAVA_WHITESPACE}]+$`);

/** Como `String.strip()` de Java. */
export function strip(value: string): string {
  return value.replace(LEADING, '').replace(TRAILING, '');
}

/** Como `String.codePointCount`: un par sustituto cuenta uno; un sustituto suelto también. */
export function codePointLength(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}
