/*
 * El texto original de cada número del cuerpo JSON. JSON.parse lo convierte en double y pierde su
 * forma (1.50, 1e2, 123456789012.123456); Jackson lee el texto, y un importe que llega como número
 * debe validarse y guardarse con los dígitos que se enviaron. El parser (json-body.ts) lo anota con
 * el `source` que Node pasa al reviver, junto al objeto o array que contiene el número.
 */

const sources = new WeakMap<object, Map<string, string>>();

/** Reviver de JSON.parse que anota el texto de cada número. */
export function recordNumberSource(
  this: unknown,
  key: string,
  value: unknown,
  context?: { source?: string },
): unknown {
  if (typeof value === 'number' && typeof this === 'object' && this !== null && context?.source !== undefined) {
    let byKey = sources.get(this);
    if (byKey === undefined) sources.set(this, (byKey = new Map()));
    byKey.set(key, context.source);
  }
  return value;
}

/** El texto con que llegó el número `holder[key]`, o undefined si no vino de un cuerpo JSON. */
export function numberSource(holder: unknown, key: string | number): string | undefined {
  return typeof holder === 'object' && holder !== null ? sources.get(holder)?.get(String(key)) : undefined;
}

/** Si el número se escribió con decimales o exponente (un VALUE_NUMBER_FLOAT de Jackson). */
export function isFloatToken(holder: unknown, key: string | number, value: number): boolean {
  const source = numberSource(holder, key);
  return source === undefined ? !Number.isInteger(value) : /[.eE]/.test(source);
}
