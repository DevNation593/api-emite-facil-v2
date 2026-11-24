/*
 * Fechas del SRI leídas como `OffsetDateTime.parse` (ISO_OFFSET_DATE_TIME) y, si no traen desplazamiento,
 * como `LocalDateTime.parse` con -05:00; escritas como `OffsetDateTime.toString()`. Las reglas las fija el
 * golden `sri.json` (familia `sri` del generador): la T y la Z sin distinguir mayúsculas, segundos
 * opcionales, fracción de 1 a 9 cifras, desplazamiento ±HH, ±HH:MM o ±HH:MM:SS hasta ±18:00 y resolución
 * estricta (ni 30 de febrero, ni 24:00, ni segundo 60).
 */

export interface OffsetDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  nano: number;
  /** Desplazamiento en segundos. */
  offsetSeconds: number;
}

const PATTERN =
  /^((?:[0-9]{4})|(?:[+-][0-9]{4,9}))-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,9}))?)?(?:([Zz])|([+-])([0-9]{2})(?::([0-9]{2})(?::([0-9]{2}))?)?)?$/;

const MAX_OFFSET_SECONDS = 18 * 3600;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/**
 * Lee la fecha; sin desplazamiento usa `defaultOffsetSeconds`. Devuelve null si Java no la leería.
 */
export function parseOffsetDateTime(text: string, defaultOffsetSeconds: number): OffsetDateTime | null {
  const match = PATTERN.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, fraction, zulu, sign, oh, om, os] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  const nano = fraction === undefined ? 0 : Number(fraction.padEnd(9, '0'));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetSeconds = defaultOffsetSeconds;
  if (zulu !== undefined) {
    offsetSeconds = 0;
  } else if (sign !== undefined) {
    const hours = Number(oh);
    const minutes = om === undefined ? 0 : Number(om);
    const seconds = os === undefined ? 0 : Number(os);
    if (hours > 18 || minutes > 59 || seconds > 59) return null;
    const total = hours * 3600 + minutes * 60 + seconds;
    if (total > MAX_OFFSET_SECONDS) return null;
    offsetSeconds = sign === '-' ? -total : total;
  }
  return { year, month, day, hour, minute, second, nano, offsetSeconds };
}

/** Días desde 1970-01-01 (calendario gregoriano proléptico). */
function epochDay(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** El instante en nanosegundos desde la época, para comparar. */
export function epochNanos(value: OffsetDateTime): bigint {
  const seconds =
    BigInt(epochDay(value.year, value.month, value.day)) * 86_400n +
    BigInt(value.hour * 3600 + value.minute * 60 + value.second - value.offsetSeconds);
  return seconds * 1_000_000_000n + BigInt(value.nano);
}

const pad = (value: number, width: number) => String(value).padStart(width, '0');

function yearText(year: number): string {
  const abs = Math.abs(year);
  if (abs < 1000) return `${year < 0 ? '-' : ''}${pad(abs, 4)}`;
  return `${year > 9999 ? '+' : ''}${year}`;
}

/** Como `OffsetDateTime.toString()`: `2012-03-05T16:57:34.997-05:00`, `2026-10-11T09:30Z`. */
export function formatOffsetDateTime(value: OffsetDateTime): string {
  let time = `${pad(value.hour, 2)}:${pad(value.minute, 2)}`;
  if (value.second > 0 || value.nano > 0) {
    time += `:${pad(value.second, 2)}`;
    if (value.nano > 0) {
      if (value.nano % 1_000_000 === 0) time += `.${pad(value.nano / 1_000_000, 3)}`;
      else if (value.nano % 1000 === 0) time += `.${pad(value.nano / 1000, 6)}`;
      else time += `.${pad(value.nano, 9)}`;
    }
  }
  let offset = 'Z';
  if (value.offsetSeconds !== 0) {
    const abs = Math.abs(value.offsetSeconds);
    offset = `${value.offsetSeconds < 0 ? '-' : '+'}${pad(Math.floor(abs / 3600), 2)}:${pad(Math.floor((abs % 3600) / 60), 2)}`;
    if (abs % 60 !== 0) offset += `:${pad(abs % 60, 2)}`;
  }
  return `${yearText(value.year)}-${pad(value.month, 2)}-${pad(value.day, 2)}T${time}${offset}`;
}
