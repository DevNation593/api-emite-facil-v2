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

const UTC_TIMESTAMP = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?$/;

/**
 * El `ISO_INSTANT` con que Jackson escribe un instante: recibe `YYYY-MM-DDTHH:MM:SS.ffffff` en UTC
 * (el texto de PostgreSQL, con sus microsegundos) y devuelve los segundos siempre y la fracción con
 * 0, 3, 6 o 9 dígitos, lo justo para no perder ninguno, seguida de `Z`.
 */
export function isoInstant(utc: string): string {
  const match = UTC_TIMESTAMP.exec(utc);
  if (match === null) throw new Error(`No es un instante UTC sin zona: ${utc}`);
  const [, seconds, fraction = ''] = match;
  const digits = fraction.padEnd(9, '0');
  if (digits === '000000000') return `${seconds}Z`;
  const shown = digits.endsWith('000000') ? digits.slice(0, 3) : digits.endsWith('000') ? digits.slice(0, 6) : digits;
  return `${seconds}.${shown}Z`;
}

/*
 * LocalDate como lo lee y escribe Java: ISO_LOCAL_DATE con ResolverStyle.STRICT y el calendario
 * ISO proléptico, en el rango de LocalDate (años -999999999 a 999999999).
 */

const MAX_YEAR = 999_999_999;
const DAYS_0000_TO_1970 = 719_528n;
const DAYS_PER_CYCLE = 146_097n;
const MIN_EPOCH_DAY = -365_243_219_162n;
const MAX_EPOCH_DAY = 365_241_780_471n;

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function lengthOfMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** `LocalDate.toString()`: cuatro cifras de año como mínimo, y `+` si pasa de 9999. */
function formatLocalDate(year: number, month: number, day: number): string {
  const absolute = Math.abs(year);
  const yearText =
    absolute < 1000
      ? `${year < 0 ? '-' : ''}${String(absolute).padStart(4, '0')}`
      : `${year > 9999 ? '+' : ''}${year}`;
  return `${yearText}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** `LocalDate.of(year, month, day)` en texto, o null si Java lanzaría DateTimeException. */
export function localDateOf(year: number, month: number, day: number): string | null {
  if (![year, month, day].every(Number.isInteger) || Math.abs(year) > MAX_YEAR) return null;
  if (month < 1 || month > 12 || day < 1 || day > lengthOfMonth(year, month)) return null;
  return formatLocalDate(year, month, day);
}

/** `LocalDate.ofEpochDay(epochDay)` en texto (el algoritmo de Java), o null fuera de rango. */
export function localDateOfEpochDay(epochDay: bigint): string | null {
  if (epochDay < MIN_EPOCH_DAY || epochDay > MAX_EPOCH_DAY) return null;
  // Año que empieza el 1 de marzo, para que el 29 de febrero quede al final del ciclo de cuatro.
  let zeroDay = epochDay + DAYS_0000_TO_1970 - 60n;
  let adjust = 0n;
  if (zeroDay < 0n) {
    const adjustCycles = (zeroDay + 1n) / DAYS_PER_CYCLE - 1n;
    adjust = adjustCycles * 400n;
    zeroDay += -adjustCycles * DAYS_PER_CYCLE;
  }
  const dayOfYear = (year: bigint) => zeroDay - (365n * year + year / 4n - year / 100n + year / 400n);
  let yearEstimate = (400n * zeroDay + 591n) / DAYS_PER_CYCLE;
  let marchDayOfYear = dayOfYear(yearEstimate);
  if (marchDayOfYear < 0n) {
    yearEstimate--;
    marchDayOfYear = dayOfYear(yearEstimate);
  }
  yearEstimate += adjust;
  const marchDoy0 = Number(marchDayOfYear);
  const marchMonth0 = Math.trunc((marchDoy0 * 5 + 2) / 153);
  const month = ((marchMonth0 + 2) % 12) + 1;
  const day = marchDoy0 - Math.trunc((marchMonth0 * 306 + 5) / 10) + 1;
  const year = Number(yearEstimate) + (marchDoy0 >= 306 ? 1 : 0);
  return formatLocalDate(year, month, day);
}

// El año: 4 cifras sin signo, 5 a 10 con `+`, o 4 a 10 con `-` (SignStyle.EXCEEDS_PAD estricto).
const ISO_LOCAL_DATE = /^([+-]?)([0-9]{4,10})-([0-9]{2})-([0-9]{2})$/;
const ISO_LOCAL_TIME = /^([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]{0,9})?)?$/;

/** `LocalDate.parse(text)` (ISO_LOCAL_DATE, estricto) en texto, o null si no se puede leer. */
export function parseIsoLocalDate(text: string): string | null {
  const match = ISO_LOCAL_DATE.exec(text);
  if (match === null) return null;
  const [, sign, digits, month, day] = match as unknown as [string, string, string, string, string];
  if (sign === '' && digits.length !== 4) return null;
  if (sign === '+' && digits.length <= 4) return null;
  const year = Number(digits);
  if (sign === '-' && year === 0) return null;
  return localDateOf(sign === '-' ? -year : year, Number(month), Number(day));
}

/** `LocalDate.parse(text, ISO_LOCAL_DATE_TIME)`: la fecha de una fecha y hora, o null. */
export function parseIsoLocalDateTimeDate(text: string): string | null {
  const t = text.indexOf('T');
  if (t < 0) return null;
  const time = ISO_LOCAL_TIME.exec(text.slice(t + 1));
  if (time === null) return null;
  const [, hour, minute, second = '0'] = time;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return parseIsoLocalDate(text.slice(0, t));
}
