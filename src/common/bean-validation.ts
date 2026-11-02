import { Allow, registerDecorator, type ValidationOptions } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiException } from './api-exception.js';
import { idnToAscii } from './idn.js';
import { jacksonUuid } from './java-uuid.js';
import { javaTrim, strip } from './java-text.js';

/*
 * Decoradores con la semántica y los mensajes de Bean Validation (Hibernate Validator,
 * locale por defecto). Solo @NotNull y @NotBlank rechazan null/undefined; el resto los acepta.
 */

function constraint(
  name: string,
  message: string,
  test: (value: unknown) => boolean,
  options?: ValidationOptions,
): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name,
      target: target.constructor,
      propertyName: propertyName as string,
      options: { message, ...options },
      validator: { validate: test },
    });
}

export const NotNull = (options?: ValidationOptions): PropertyDecorator =>
  constraint('notNull', 'must not be null', (v) => v !== null && v !== undefined, options);

/** `strip()` de Java (Character.isWhitespace), no `trim()` de JS. */
export const NotBlank = (options?: ValidationOptions): PropertyDecorator =>
  constraint(
    'notBlank',
    'must not be blank',
    (v) => typeof v === 'string' && strip(v).length > 0,
    options,
  );

/** Cuenta unidades UTF-16, como `String.length()`. */
export const Size = (
  { max, min = 0 }: { max: number; min?: number },
  options?: ValidationOptions,
): PropertyDecorator =>
  constraint(
    'size',
    `size must be between ${min} and ${max}`,
    (v) =>
      v === null ||
      v === undefined ||
      (typeof v === 'string' && v.length >= min && v.length <= max),
    options,
  );
// Con la bandera `u` los rangos 0x80 a 0xFFFF excluyen los caracteres fuera del plano
// básico, como los Pattern de Java (que trabajan por code point). Las comillas escapadas
// de la parte local se escriben `\\"` (barra y comilla): `\"` no es válido con `u`.
// Constantes por código: así el fuente no lleva el acento grave ni U+FFFF literales.
const BACKTICK = String.fromCharCode(0x60);
const LOW = String.fromCharCode(0x80);
const HIGH = String.fromCharCode(0xffff);
const LOCAL_ATOM = `[a-z0-9!#$%&'*+/=?^_${BACKTICK}{|}~${LOW}-${HIGH}-]`;
const LOCAL_QUOTED_ATOM =
  `(?:[a-z0-9!#$%&'*.(),<>\\[\\]:;  @+/=?^_${BACKTICK}{|}~${LOW}-${HIGH}-]|\\\\\\\\|\\\\")`;
const LOCAL_WORD = `(?:${LOCAL_ATOM}+|"${LOCAL_QUOTED_ATOM}+")`;
const LOCAL_PART = new RegExp(`^${LOCAL_WORD}(?:\\.${LOCAL_WORD})*$`, 'iu');

const DOMAIN_CHAR = `[a-z${LOW}-${HIGH}0-9!#$%&'*+/=?^_${BACKTICK}{|}~]`;
const DOMAIN_LABEL = `${DOMAIN_CHAR}+(?:-+${DOMAIN_CHAR}+)*`;
const DOMAIN_NAME = `${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*`;
const OCTET = String.raw`(?:25[0-5]|(?:2[0-4]|1{0,1}[0-9]){0,1}[0-9])`;
const IPV6 =
  String.raw`(?:(?:[0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|` +
  String.raw`(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|` +
  String.raw`(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|` +
  String.raw`[0-9a-fA-F]{1,4}:(?:(?::[0-9a-fA-F]{1,4}){1,6})|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)|` +
  String.raw`fe80:(?::[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|` +
  String.raw`::(?:ffff(?::0{1,4}){0,1}:){0,1}(?:${OCTET}\.){3,3}${OCTET}|` +
  String.raw`(?:[0-9a-fA-F]{1,4}:){1,4}:(?:${OCTET}\.){3,3}${OCTET})`;
const EMAIL_DOMAIN = new RegExp(
  `^(?:${DOMAIN_NAME}|\\[[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\]|\\[IPv6:${IPV6}\\])$`,
  'iu',
);


/** Porta `AbstractEmailValidator` + `DomainNameUtil` de Hibernate Validator. */
export function isValidEmail(value: string): boolean {
  if (value.length === 0) return true;
  const at = value.lastIndexOf('@');
  if (at < 0) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local)) return false;
  if (domain.endsWith('.')) return false;
  // Hibernate mide el dominio en ASCII (IDN) pero aplica la expresión al texto original.
  const ascii = idnToAscii(domain);
  return ascii !== null && ascii.length <= 255 && EMAIL_DOMAIN.test(domain);
}

export const Email = (options?: ValidationOptions): PropertyDecorator =>
  constraint(
    'email',
    'must be a well-formed email address',
    (v) => v === null || v === undefined || (typeof v === 'string' && isValidEmail(v)),
    options,
  );

/** `\p{Cntrl}` de Java es solo ASCII (U+0000–U+001F y U+007F). */
// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

/** `@Pattern(regexp = TextRules.NO_CONTROL_CHARS)`. */
export const NoControlChars = (options?: ValidationOptions): PropertyDecorator =>
  constraint(
    'noControlChars',
    'must match "[^\\p{Cntrl}]*"',
    (v) => v === null || v === undefined || (typeof v === 'string' && NO_CONTROL.test(v)),
    options,
  );

/**
 * `@Pattern(regexp = …)`: el texto entero debe coincidir, como `Matcher.matches()`. La expresión
 * debe significar lo mismo en Java y en JS (clases ASCII como `[0-9]`).
 */
export const Pattern = (regexp: string, options?: ValidationOptions): PropertyDecorator => {
  const whole = new RegExp(`^(?:${regexp})$`, 'u');
  return constraint(
    'pattern',
    `must match "${regexp}"`,
    (v) => v === null || v === undefined || (typeof v === 'string' && whole.test(v)),
    options,
  );
};

/** `@Min(value)`. */
export const Min = (min: number, options?: ValidationOptions): PropertyDecorator =>
  constraint(
    'min',
    `must be greater than or equal to ${min}`,
    (v) => v === null || v === undefined || (typeof v === 'number' && v >= min),
    options,
  );

/** `@Max(value)`. */
export const Max = (max: number, options?: ValidationOptions): PropertyDecorator =>
  constraint(
    'max',
    `must be less than or equal to ${max}`,
    (v) => v === null || v === undefined || (typeof v === 'number' && v <= max),
    options,
  );

/*
 * Coerciones de Jackson para las propiedades que no son texto. Lo que cada una admite y convierte
 * sale de las respuestas de la API Java (test/golden/http/e2.json). Lo que Jackson no sabe leer es
 * JSON no legible: 400 MALFORMED_REQUEST. Cada una incluye `@Allow()` para que `whitelist` no
 * descarte la propiedad si no lleva otra restricción.
 */

const notJson = () => new ApiException(400, 'MALFORMED_REQUEST', 'El cuerpo de la petición no es JSON válido');

function jsonCoercion(convert: (value: unknown) => unknown): PropertyDecorator {
  const allow = Allow();
  const transform = Transform(({ value }: { value: unknown }) =>
    value === null || value === undefined ? value : convert(value),
  );
  return (target, propertyName) => {
    allow(target, propertyName);
    transform(target, propertyName);
  };
}

/** Texto: número o booleano pasan a texto; un objeto o un array son JSON no legible. */
export const JsonString = (): PropertyDecorator =>
  jsonCoercion((value) => {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') throw notJson();
    return value;
  });

const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;

/**
 * `Integer`: un número decimal se trunca hacia cero (5.7 da 5); un texto se recorta y se lee en
 * decimal con signo opcional ("" es null); fuera del rango de int, o cualquier otra cosa, no se lee.
 */
export const JsonInteger = (): PropertyDecorator =>
  jsonCoercion((value) => {
    let number: number;
    if (typeof value === 'number') {
      number = Math.trunc(value) || 0;
    } else if (typeof value === 'string') {
      const text = javaTrim(value);
      if (text === '') return null;
      if (!/^[+-]?[0-9]+$/.test(text)) throw notJson();
      number = Number(text);
    } else {
      throw notJson();
    }
    if (number < INT_MIN || number > INT_MAX) throw notJson();
    return number;
  });

const TRUE = new Set(['true', 'True', 'TRUE']);
const FALSE = new Set(['false', 'False', 'FALSE']);

/**
 * `Boolean`: un entero es true salvo el 0; un texto recortado vale si es true o false (en
 * minúsculas, capitalizado o en mayúsculas) y "" es null. "1", "si" o un decimal no se leen.
 */
export const JsonBoolean = (): PropertyDecorator =>
  jsonCoercion((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) throw notJson();
      return value !== 0;
    }
    if (typeof value === 'string') {
      const text = javaTrim(value);
      if (text === '') return null;
      if (TRUE.has(text)) return true;
      if (FALSE.has(text)) return false;
    }
    throw notJson();
  });

/**
 * Enum: el nombre exacto (el texto se recorta), o su posición como entero o como texto de dígitos
 * (1 o "1" es el segundo valor). "", otra caja, una posición fuera de rango o un decimal no se leen.
 */
export const JsonEnum = (values: readonly string[]): PropertyDecorator =>
  jsonCoercion((value) => {
    if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= 0 && value < values.length) return values[value];
      throw notJson();
    }
    if (typeof value === 'string') {
      const text = javaTrim(value);
      if (values.includes(text)) return text;
      if (/^[0-9]+$/.test(text) && Number(text) < values.length) return values[Number(text)];
    }
    throw notJson();
  });

/** `UUID`: el texto recortado, de 36 caracteres (cualquier caja) o 24 en Base64; "" es null. */
export const JsonUuid = (): PropertyDecorator =>
  jsonCoercion((value) => {
    if (typeof value !== 'string') throw notJson();
    const text = javaTrim(value);
    if (text === '') return null;
    const id = jacksonUuid(text);
    if (id === null) throw notJson();
    return id;
  });
