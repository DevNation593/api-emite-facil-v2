import { strip } from '../common/java-text.js';

/** Más larga que cualquier IPv6 escrita; lo que la supere no es una dirección. */
const MAX_LENGTH = 64;

/**
 * La IP de quien llama, para el límite de intentos por IP de /api/v1/auth.
 *
 * Cada proxy de confianza añade su entrada al final de X-Forwarded-For; lo que hay a la izquierda
 * lo escribe quien llama y no vale. Con `hops` proxies de confianza, la IP es la entrada que queda
 * en esa posición contando desde la derecha. Si hay menos entradas que proxies, todas las puso
 * alguno de confianza y vale la primera. Varias cabeceras cuentan como una sola lista, en su orden.
 *
 * Sin cabecera utilizable (vacía o con una entrada vacía o demasiado larga) se usa la dirección
 * remota de la conexión.
 */
export function clientAddress(
  headers: string | string[] | undefined,
  remoteAddress: string | undefined,
  hops: number,
): string {
  return fromForwardedFor(headers, hops) ?? remote(remoteAddress);
}

function fromForwardedFor(headers: string | string[] | undefined, hops: number): string | null {
  const list = headers === undefined ? [] : Array.isArray(headers) ? headers : [headers];
  const entries: string[] = [];
  for (const header of list) {
    if (strip(header) === '') continue;
    for (const entry of header.split(',')) entries.push(strip(entry));
  }
  if (entries.length === 0) return null;
  const entry = entries[Math.max(0, entries.length - hops)]!;
  return entry === '' || entry.length > MAX_LENGTH ? null : entry;
}

/** Node entrega las conexiones IPv4 de un socket dual como `::ffff:a.b.c.d`. */
function remote(remoteAddress: string | undefined): string {
  if (remoteAddress === undefined || remoteAddress === '') return 'unknown';
  return remoteAddress.startsWith('::ffff:')
    ? remoteAddress.substring('::ffff:'.length)
    : remoteAddress;
}
