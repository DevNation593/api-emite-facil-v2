/*
 * Aproximación de `java.net.IDN.toASCII` (IDNA 2003: nameprep + punycode), lo que
 * Hibernate Validator usa para medir y rechazar el dominio de un correo. Cubre lo que
 * cambia el veredicto de @Email: etiquetas vacías, más de 63 caracteres tras el punycode,
 * puntos de código prohibidos y los que Unicode 3.2 (el de stringprep) aún no asignaba.
 * No porta las tablas completas de nameprep.
 */

const LABEL_SEPARATORS = new RegExp('[.\\u3002\\uff0e\\uff61]');
// Tabla B.1: se eliminan antes de normalizar.
const MAPPED_TO_NOTHING = new RegExp('\\u034f|\\ufe0[0-9a-f]|[\\u00ad\\u180b-\\u180d\\u200b-\\u200d\\u2060\\ufeff]', 'g');
// Tablas C.1.2, C.2.2, C.3 a C.9 (subconjunto relevante).
const PROHIBITED = new RegExp(
  '[\\u0080-\\u009f\\u1680\\u180e\\u2028\\u2029\\u2061-\\u2063\\u206a-\\u206f\\ue000-\\uf8ff\\ufdd0-\\ufdef\\ufff9-\\uffff\\u2ff0-\\u2ffb\\ud800-\\udfff]',
  'u',
);

// Planos suplementarios que Unicode 3.2 ya tenía asignados.
const ASSIGNED_ASTRAL: Array<[number, number]> = [
  [0x10300, 0x1034a],
  [0x10400, 0x10425],
  [0x10428, 0x1044d],
  [0x1d000, 0x1d0f5],
  [0x1d100, 0x1d126],
  [0x1d12a, 0x1d1dd],
  [0x1d400, 0x1d7ff],
  [0x20000, 0x2a6d6],
  [0x2f800, 0x2fa1d],
  [0xe0001, 0xe0001],
  [0xe0020, 0xe007f],
];

function hasUnassignedAstral(label: string): boolean {
  for (const char of label) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0xffff && !ASSIGNED_ASTRAL.some(([from, to]) => code >= from && code <= to)) {
      return true;
    }
  }
  return false;
}

/** Codificación Punycode (RFC 3492) de una etiqueta ya normalizada. */
function punycode(input: string): string {
  const base = 36;
  const codePoints = Array.from(input, (c) => c.codePointAt(0) ?? 0);
  const digit = (d: number) => String.fromCharCode(d < 26 ? d + 97 : d + 22);
  const adapt = (delta: number, points: number, first: boolean) => {
    let d = first ? Math.floor(delta / 700) : delta >> 1;
    d += Math.floor(d / points);
    let k = 0;
    while (d > 455) {
      d = Math.floor(d / 35);
      k += base;
    }
    return k + Math.floor((36 * d) / (d + 38));
  };
  let output = codePoints.filter((c) => c < 0x80).map((c) => String.fromCharCode(c)).join('');
  const basic = output.length;
  let handled = basic;
  if (basic > 0) output += '-';
  let n = 128;
  let delta = 0;
  let bias = 72;
  while (handled < codePoints.length) {
    const next = Math.min(...codePoints.filter((c) => c >= n));
    delta += (next - n) * (handled + 1);
    n = next;
    for (const c of codePoints) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = base; ; k += base) {
          const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
          if (q < t) break;
          output += digit(t + ((q - t) % (base - t)));
          q = Math.floor((q - t) / (base - t));
        }
        output += digit(q);
        bias = adapt(delta, handled + 1, handled === basic);
        delta = 0;
        handled++;
      }
    }
    delta++;
    n++;
  }
  return output;
}

/** El dominio en ASCII, o null donde Java lanzaría (`IDN.toASCII` con flags 0). */
export function idnToAscii(domain: string): string | null {
  const labels: string[] = [];
  for (const raw of domain.split(LABEL_SEPARATORS)) {
    let label = raw;
    // eslint-disable-next-line no-control-regex
    if (/[^\u0000-\u007f]/.test(label)) {
      label = label.replace(MAPPED_TO_NOTHING, '').normalize('NFKC').toLowerCase();
      if (PROHIBITED.test(label) || hasUnassignedAstral(label)) return null;
      // eslint-disable-next-line no-control-regex
      if (/[^\u0000-\u007f]/.test(label)) label = `xn--${punycode(label)}`;
    }
    if (label.length === 0 || label.length > 63) return null;
    labels.push(label);
  }
  return labels.join('.');
}
