/**
 * Contenido propio de cada tipo de comprobante como JSON (billing/JsonContentKind.java). El mapper de Java es
 * fijo: todo `BigDecimal`, también el anidado, se escribe como cadena JSON con `toString()` para que vuelva con
 * la misma escala; las propiedades salen en el orden del record y los `null` se escriben; al leer, una
 * propiedad desconocida falla (un campo renombrado no se carga como nulo en silencio) y una que falta queda
 * `null`. Un solo códec dirigido por la forma del record sirve a los tres tipos.
 */
import { BigDecimal } from '../common/big-decimal.js';
import { jacksonUuid } from '../common/java-uuid.js';

export type ContentType = 'string' | 'integer' | 'uuid' | 'decimal' | ListType;

/** Lista de records anidados, con la forma de cada elemento. */
export interface ListType {
  readonly kind: 'list';
  readonly shape: ContentShape;
}

/** Propiedades del record en el orden en que Java declara sus componentes. */
export type ContentShape = readonly (readonly [
  name: string,
  type: ContentType,
])[];

export function list(shape: ContentShape): ListType {
  return { kind: 'list', shape };
}

export interface ContentCodec<C> {
  write(content: C): string;
  read(json: string): C;
}

export function contentCodec<C>(shape: ContentShape): ContentCodec<C> {
  return {
    write: (content) => writeRecord(content, shape),
    read: (json) => readRecord(JSON.parse(json) as unknown, shape) as C,
  };
}

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** Como el generador de Jackson: solo escapa comillas, barra invertida y controles (hex en mayúsculas). */
export function quote(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const short = SHORT_ESCAPES[ch];
    if (short !== undefined) out += short;
    else if (ch < ' ')
      out += `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function writeRecord(record: unknown, shape: ContentShape): string {
  const source = record as Record<string, unknown>;
  const parts = shape.map(
    ([name, type]) => `${quote(name)}:${writeValue(source[name], type, name)}`,
  );
  return `{${parts.join(',')}}`;
}

function writeValue(value: unknown, type: ContentType, name: string): string {
  if (value === null || value === undefined) return 'null';
  if (typeof type === 'object') {
    if (!Array.isArray(value)) throw new Error(`${name} debe ser una lista`);
    return `[${value.map((item) => (item === null ? 'null' : writeRecord(item, type.shape))).join(',')}]`;
  }
  switch (type) {
    case 'string':
    case 'uuid':
      if (typeof value !== 'string') throw new Error(`${name} debe ser texto`);
      return quote(value);
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value))
        throw new Error(`${name} debe ser un entero`);
      return String(value);
    case 'decimal':
      if (!(value instanceof BigDecimal))
        throw new Error(`${name} debe ser un BigDecimal`);
      return quote(value.toString());
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(
  raw: unknown,
  shape: ContentShape,
): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error('El contenido debe ser un objeto JSON');
  const known = new Set(shape.map(([name]) => name));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new Error(`Propiedad desconocida: ${key}`);
  }
  const out: Record<string, unknown> = {};
  for (const [name, type] of shape) {
    out[name] = Object.hasOwn(raw, name)
      ? readValue(raw[name], type, name)
      : null;
  }
  return out;
}

function readValue(value: unknown, type: ContentType, name: string): unknown {
  if (value === null) return null;
  if (typeof type === 'object') {
    if (!Array.isArray(value)) throw new Error(`${name} debe ser una lista`);
    return value.map((item) =>
      item === null ? null : readRecord(item, type.shape),
    );
  }
  switch (type) {
    case 'string':
      if (typeof value !== 'string') throw new Error(`${name} debe ser texto`);
      return value;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value))
        throw new Error(`${name} debe ser un entero`);
      return value;
    case 'uuid': {
      const uuid = typeof value === 'string' ? jacksonUuid(value) : null;
      if (uuid === null) throw new Error(`${name} no es un UUID válido`);
      return uuid;
    }
    case 'decimal':
      if (typeof value !== 'string')
        throw new Error(`${name} debe ser un decimal escrito como texto`);
      return BigDecimal.of(value);
  }
}
