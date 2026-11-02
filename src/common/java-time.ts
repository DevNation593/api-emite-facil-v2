/*
 * Instantes con el texto que produce Java para un OffsetDateTime en UTC. Date solo guarda
 * milisegundos: las fracciones más finas de PostgreSQL ya se perdieron al leerlas.
 */

function base(date: Date): { minute: string; seconds: number; millis: number } {
  const iso = date.toISOString();
  return { minute: iso.slice(0, 16), seconds: date.getUTCSeconds(), millis: date.getUTCMilliseconds() };
}

/** Como Jackson (ISO_OFFSET_DATE_TIME): siempre los segundos, y la fracción sin ceros finales. */
export function offsetDateTimeJson(date: Date): string {
  const { minute, seconds, millis } = base(date);
  const fraction = millis === 0 ? '' : `.${String(millis).padStart(3, '0').replace(/0+$/, '')}`;
  return `${minute}:${String(seconds).padStart(2, '0')}${fraction}Z`;
}

/** Como `OffsetDateTime.toString()`: sin segundos si son cero, y la fracción en grupos de tres. */
export function offsetDateTimeToString(date: Date): string {
  const { minute, seconds, millis } = base(date);
  if (seconds === 0 && millis === 0) return `${minute}Z`;
  const fraction = millis === 0 ? '' : `.${String(millis).padStart(3, '0')}`;
  return `${minute}:${String(seconds).padStart(2, '0')}${fraction}Z`;
}
