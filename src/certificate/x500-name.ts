import forge from 'node-forge';

/*
 * Nombre distinguido con el texto de `X500Principal.getName()` de Java (RFC 2253 sin mapa de
 * palabras clave). Lo que Java guarda como subject e issuer del certificado sale de aquí, así que
 * debe coincidir carácter a carácter.
 */

// Solo estos atributos llevan nombre en RFC 2253; el resto se escribe como OID.
const KEYWORDS: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.9': 'STREET',
  '0.9.2342.19200300.100.1.25': 'DC',
  '0.9.2342.19200300.100.1.1': 'UID',
};

const T = forge.asn1.Type;
// Etiquetas que los tipos de forge no nombran.
const T61_STRING = 20;
const GENERAL_STRING = 27;
// isDerString de Java (modo no canónico): los demás tipos se escriben como # y su DER.
const STRING_TYPES = new Set<number>([T.PRINTABLESTRING, T61_STRING, T.IA5STRING, GENERAL_STRING, T.BMPSTRING, T.UTF8]);
// Se escapan en cualquier posición, no solo al principio (AVA.toRFC2253String).
const ESCAPEES = ',=+<>#;"\\';

function decode(node: forge.asn1.Asn1): string {
  const bytes = node.value as string;
  switch (node.type as number) {
    case T.UTF8:
      return Buffer.from(bytes, 'binary').toString('utf8');
    case T.BMPSTRING:
      return Buffer.from(bytes, 'binary').swap16().toString('utf16le');
    case T61_STRING:
      return Buffer.from(bytes, 'binary').toString('latin1');
    default:
      // US-ASCII: un byte fuera de rango se lee como U+FFFD, como el decodificador de Java.
      return Array.from(Buffer.from(bytes, 'binary'), (b) => (b < 0x80 ? String.fromCharCode(b) : '\ufffd')).join('');
  }
}

function escapeValue(text: string): string {
  let escaped = '';
  for (const c of text) {
    if (ESCAPEES.includes(c)) escaped += `\\${c}`;
    else if (c === '\u0000') escaped += '\\00';
    else escaped += c;
  }
  // Los espacios y retornos de los extremos se escapan uno a uno.
  // Unidades UTF-16, como el char[] de Java.
  const chars = escaped.split('');
  let lead = 0;
  while (lead < chars.length && (chars[lead] === ' ' || chars[lead] === '\r')) lead++;
  let trail = chars.length - 1;
  while (trail >= 0 && (chars[trail] === ' ' || chars[trail] === '\r')) trail--;
  return chars.map((c, i) => (i < lead || i > trail ? `\\${c}` : c)).join('');
}

function ava(node: forge.asn1.Asn1): string {
  const [typeNode, valueNode] = node.value as forge.asn1.Asn1[];
  const oid = forge.asn1.derToOid(typeNode!.value as string);
  const keyword = KEYWORDS[oid];
  if (keyword === undefined || !STRING_TYPES.has(valueNode!.type) || valueNode!.composed) {
    const der = forge.asn1.toDer(valueNode!).getBytes();
    return `${keyword ?? oid}=#${Buffer.from(der, 'binary').toString('hex')}`;
  }
  return `${keyword}=${escapeValue(decode(valueNode!))}`;
}

/** El nombre (ASN.1 `Name`) como `X500Principal.getName()`: RDN del último al primero. */
export function x500Name(name: forge.asn1.Asn1): string {
  const rdns = name.value as forge.asn1.Asn1[];
  return rdns
    .toReversed()
    .map((rdn) => (rdn.value as forge.asn1.Asn1[]).map(ava).join('+'))
    .join(',');
}
