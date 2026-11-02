import { Allow, registerDecorator, type ValidationOptions } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiException } from './api-exception.js';
import { idnToAscii } from './idn.js';
import { strip } from './java-text.js';

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
 * Propiedad de texto con la coerción de Jackson: número o booleano pasan a texto; un
 * objeto o un array son JSON no legible (400). Incluye `@Allow()` para que `whitelist`
 * no la descarte si no lleva otra restricción.
 */
export const JsonString = (): PropertyDecorator => {
  const allow = Allow();
  const transform = Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object' && value !== null) {
      throw new ApiException(400, 'MALFORMED_REQUEST', 'El cuerpo de la petición no es JSON válido');
    }
    return value;
  });
  return (target, propertyName) => {
    allow(target, propertyName);
    transform(target, propertyName);
  };
};
