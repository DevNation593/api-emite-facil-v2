import { Injectable, type PipeTransform } from '@nestjs/common';
import { ApiException } from './api-exception.js';
import { javaUuidFromString } from './java-uuid.js';
import { javaTrim, removeAllWhitespace } from './java-text.js';

/*
 * Parámetros de consulta con la conversión de Spring MVC (`@RequestParam`). Express entrega un
 * texto, o una lista si el parámetro se repite; Spring convierte un String[] tomando el primero
 * para un número o un UUID y uniéndolos con comas para un String. Lo que no se convierte es 400
 * MALFORMED_REQUEST "La petición está mal formada" (TypeMismatch y parámetro ausente).
 */

const malformed = () => new ApiException(400, 'MALFORMED_REQUEST', 'La petición está mal formada');

type QueryValue = unknown;

function first(value: QueryValue): string | undefined {
  if (Array.isArray(value)) return value.length === 0 ? undefined : String(value[0]);
  return typeof value === 'string' ? value : undefined;
}

const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;

/** `Integer.valueOf(text, radix)`: signo opcional y dígitos ASCII, dentro del rango de int. */
function javaParseInt(text: string, radix: 10 | 16 | 8): number | null {
  const digits = radix === 16 ? '[0-9a-fA-F]' : radix === 8 ? '[0-7]' : '[0-9]';
  if (!new RegExp(`^[+-]?${digits}+$`).test(text)) return null;
  const negative = text.startsWith('-');
  const value = Number.parseInt(text.replace(/^[+-]/, ''), radix) * (negative ? -1 : 1);
  return value < INT_MIN || value > INT_MAX ? null : value;
}

/** `Integer.decode`: signo, y luego 0x, 0X, # (hexadecimal) o 0 (octal). */
function javaDecodeInt(text: string): number | null {
  const sign = text.startsWith('-') || text.startsWith('+') ? text[0]! : '';
  let rest = text.slice(sign.length);
  let radix: 10 | 16 | 8 = 10;
  if (rest.startsWith('0x') || rest.startsWith('0X')) {
    radix = 16;
    rest = rest.slice(2);
  } else if (rest.startsWith('#')) {
    radix = 16;
    rest = rest.slice(1);
  } else if (rest.startsWith('0') && rest.length > 1) {
    radix = 8;
    rest = rest.slice(1);
  }
  if (rest.startsWith('-') || rest.startsWith('+')) return null;
  return javaParseInt(`${sign === '-' ? '-' : ''}${rest}`, radix);
}

/**
 * `NumberUtils.parseNumber(text, Integer.class)`: quita todo espacio (también el interior) y lee
 * en hexadecimal si empieza por 0x, 0X o # (con signo opcional); si no, en decimal.
 */
function springParseInt(text: string): number | null {
  const trimmed = removeAllWhitespace(text);
  const index = trimmed.startsWith('-') ? 1 : 0;
  const hex = trimmed.startsWith('0x', index) || trimmed.startsWith('0X', index) || trimmed.startsWith('#', index);
  return hex ? javaDecodeInt(trimmed) : javaParseInt(trimmed, 10);
}

/** `@RequestParam(defaultValue = "…") int`: sin valor o vacío, el predeterminado. */
@Injectable()
export class IntQueryPipe implements PipeTransform<QueryValue, number> {
  constructor(private readonly defaultValue: number) {}

  transform(value: QueryValue): number {
    const text = first(value);
    if (text === undefined || text === '') return this.defaultValue;
    const parsed = springParseInt(text);
    if (parsed === null) throw malformed();
    return parsed;
  }
}

/** `@RequestParam(defaultValue = "…") String`: repetido, sus valores unidos con comas. */
@Injectable()
export class StringQueryPipe implements PipeTransform<QueryValue, string> {
  constructor(private readonly defaultValue: string) {}

  transform(value: QueryValue): string {
    if (Array.isArray(value)) return value.map(String).join(',');
    if (typeof value !== 'string' || value === '') return this.defaultValue;
    return value;
  }
}

/** `@RequestParam UUID` obligatorio: StringToUUIDConverter (recorta y usa UUID.fromString). */
@Injectable()
export class RequiredUuidQueryPipe implements PipeTransform<QueryValue, string> {
  transform(value: QueryValue): string {
    const text = first(value);
    if (text === undefined) throw malformed();
    const trimmed = javaTrim(text);
    if (trimmed === '') throw malformed();
    const id = javaUuidFromString(trimmed);
    if (id === null) throw malformed();
    return id;
  }
}
