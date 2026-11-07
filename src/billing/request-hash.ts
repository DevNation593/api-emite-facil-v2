import { createHash } from 'node:crypto';
import { quote } from './json-content.js';

/*
 * Huella de la petición de emisión, como InvoiceController.requestHash de Java: SHA-256 en hexadecimal
 * minúsculo de los bytes que escribe `JsonMapper.writeValueAsBytes` con el record ya leído. Por eso no
 * depende del orden de las claves ni de los espacios del JSON recibido. La vista (invoiceRequestView y
 * las de las notas) trae las propiedades del record en su orden y con los null.
 */

// Un sustituto sin su pareja (los pares completos van en UTF-8).
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Cadena JSON como el generador UTF-8 de Jackson: el escape de quote() (comillas, barra invertida y
 * controles en hexadecimal mayúsculo), los pares sustitutos como su carácter y un sustituto suelto
 * como \uXXXX en mayúsculas (JSON.stringify lo escribe en minúsculas).
 */
function jacksonString(text: string): string {
  return quote(text).replace(LONE_SURROGATE, (unit) => `\\u${unit.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** JSON de texto, null, booleanos, listas y objetos, con las claves en el orden en que se escribieron. */
export function jacksonJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return jacksonString(value);
  if (typeof value === 'boolean') return String(value);
  // Un Integer (invoiceLineNo) se escribe en decimal, igual en Java y en JS.
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(jacksonJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([key, item]) => `${jacksonString(key)}:${jacksonJson(item)}`).join(',')}}`;
  }
  // Fuera de los enteros, la vista solo lleva texto: un double se escribiría con el formato de JS, no el de Java.
  throw new Error(`Valor sin forma JSON definida para la huella: ${typeof value}`);
}

export function requestHash(view: unknown): string {
  return createHash('sha256').update(Buffer.from(jacksonJson(view), 'utf8')).digest('hex');
}
