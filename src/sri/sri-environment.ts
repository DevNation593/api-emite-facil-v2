/** Ambientes del SRI, con el código que llevan en el comprobante (ficha técnica, Tabla 4), como sri/SriEnvironment.java. */
export type SriEnvironment = 'TEST' | 'PRODUCTION';

const CODES: Record<SriEnvironment, '1' | '2'> = { TEST: '1', PRODUCTION: '2' };
const LABEL_PREFIXES: Record<SriEnvironment, string> = { TEST: 'PRUEBA', PRODUCTION: 'PRODUC' };

export function codeOf(environment: SriEnvironment): '1' | '2' {
  return CODES[environment];
}

export function sriEnvironmentOf(code: string): SriEnvironment {
  if (code === '1') return 'TEST';
  if (code === '2') return 'PRODUCTION';
  throw new Error(`Ambiente desconocido: ${code}`);
}

/** Como `String.trim()` de Java: quita los caracteres hasta U+0020, no los espacios Unicode. */
export function javaTrim(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
}

/** Si el texto de la etiqueta ambiente de una autorización (PRUEBAS, PRODUCCIÓN) es este ambiente. */
export function matchesLabel(environment: SriEnvironment, label: string | null): boolean {
  if (label === null) return false;
  const plain = javaTrim(label.normalize('NFD').replace(/\p{M}/gu, '')).toUpperCase();
  return plain.startsWith(LABEL_PREFIXES[environment]);
}
