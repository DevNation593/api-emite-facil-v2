import { Writable } from 'node:stream';
import { pino, type DestinationStream, type Logger } from 'pino';
import { build as prettyStream } from 'pino-pretty';
import type { AppConfig } from '../config/app-config.js';
import { currentCorrelationId, currentDocumentId } from '../common/request-context.js';

export type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

/** Misma tabla que CloudLoggingSeverity de Java: fatal/error → ERROR, trace → DEBUG. */
export function severityOf(level: string): Severity {
  switch (level) {
    case 'fatal':
    case 'error':
      return 'ERROR';
    case 'warn':
      return 'WARNING';
    case 'info':
      return 'INFO';
    default:
      return 'DEBUG';
  }
}

const CENSORED = '[Redacted]';
// Coincidencia por subcadena y sin distinguir mayúsculas: cubre nombres reales como accessToken,
// newPassword, webhookSecret, set-cookie, proxy-authorization, jwtSecret o privateKey.
const SENSITIVE_KEY =
  /password|secret|token|api[-_]?key|authorization|cookie|p12|masterkey|private[-_]?key/i;
// Datos del SRI que contienen «authorization» y no son secretos: se registran a sabiendas.
const NOT_SENSITIVE = new Set(['authorizationNumber', 'authorizationDate', 'authorizedAt']);

const sensitive = (key: string) => !NOT_SENSITIVE.has(key) && SENSITIVE_KEY.test(key);

// esquema://usuario:clave@host: la clave se enmascara en cualquier valor de texto, sea cual sea la
// propiedad (redis://:clave@host, postgresql://app:clave@db…). Codicioso hasta el último @ de la
// autoridad por si la clave trae uno sin codificar.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]*:)[^\s/?#]*@/gi;

function scrubString(value: string): string {
  return value.replace(URL_CREDENTIALS, `$1${CENSORED}@`);
}

const MAX_DEPTH = 20;
const TRUNCATED = '[Truncado]';

/**
 * Censura por nombre de clave a cualquier profundidad (también dentro de
 * arrays y de las propiedades propias de un Error, p. ej. `config.headers` de
 * un cliente HTTP). Copia al escribir: el objeto del llamador no se muta y, si
 * no hay nada que censurar, se devuelve la misma referencia. Los ciclos se
 * cortan y la profundidad se acota para no desbordar la pila dentro del log.
 */
function censor(value: unknown, path: Set<object> = new Set()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (ArrayBuffer.isView(value) || value instanceof Date) return value;
  if (path.has(value)) return '[Circular]';
  if (path.size >= MAX_DEPTH) return TRUNCATED;
  path.add(value);
  let copy: Record<string, unknown> | unknown[] | undefined;
  const entries: Array<[string | number, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [i, v])
    : Object.entries(value);
  for (const [key, original] of entries) {
    const next =
      typeof key === 'string' && sensitive(key)
        ? CENSORED
        : censor(original, path);
    if (next !== original) {
      copy ??= Array.isArray(value) ? [...value] : { ...value };
      (copy as Record<string | number, unknown>)[key] = next;
    }
  }
  if (value instanceof Error) {
    // message, stack y cause no son enumerables: se limpian aparte (p. ej. un ECONNREFUSED con la URL). La
    // causa se censura igual que el error y sale como objeto plano (un Error no se serializa en JSON).
    const message = scrubString(value.message);
    const stack = value.stack === undefined ? undefined : scrubString(value.stack);
    const hasCause = value.cause !== undefined;
    const cause = hasCause ? plainCause(censor(value.cause, path)) : undefined;
    path.delete(value);
    if (copy === undefined && !hasCause && message === value.message && stack === value.stack) return value;
    // Un Error censurado pasa a objeto plano conservando lo que el formato necesita.
    return {
      ...((copy ?? Object.assign({}, value)) as Record<string, unknown>),
      type: value.constructor.name,
      message,
      stack,
      ...(hasCause ? { cause } : {}),
    };
  }
  path.delete(value);
  if (copy === undefined) return value;
  return copy;
}

/** Una causa ya censurada que sigue siendo un Error (no había nada que limpiar) pasa a objeto plano. */
function plainCause(cause: unknown): unknown {
  if (!(cause instanceof Error)) return cause;
  const plain: Record<string, unknown> = Object.fromEntries(Object.entries(cause));
  return Object.assign(plain, { type: cause.constructor.name, message: cause.message, stack: cause.stack });
}

/** Rutas censuradas: nunca deben llegar a un log (restricción global del proyecto). */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  '*.password',
  '*.p12',
  '*.secret',
  '*.token',
  '*.masterKey',
  'password',
  'p12',
  'secret',
  'token',
  'masterKey',
];

/**
 * Nest registra errores como `err` (objeto con stack); el formato de Cloud
 * Logging espera `stack_trace` y el texto en `message`.
 */
function formatLog(raw: Record<string, unknown>): Record<string, unknown> {
  return flattenError(censor(raw) as Record<string, unknown>);
}

function flattenError(object: Record<string, unknown>): Record<string, unknown> {
  const { err, ...rest } = object as {
    err?: { message?: string; stack?: string; code?: unknown; cause?: unknown };
    [key: string]: unknown;
  };
  if (err === undefined || typeof err !== 'object' || err === null) return object;
  if (err.stack !== undefined) rest['stack_trace'] = err.stack;
  if (rest['message'] === undefined && err.message !== undefined) {
    rest['message'] = err.message;
  }
  // El código (ECONNREFUSED, 23505…) y la causa ya censurada dicen qué falló sin abrir la pila.
  if (rest['code'] === undefined && err.code !== undefined) rest['code'] = err.code;
  if (rest['cause'] === undefined && err.cause !== undefined) rest['cause'] = plainCause(err.cause);
  return rest;
}

/** pino-pretty exige un stream real; adapta destinos mínimos con solo `write`. */
function asWritable(destination: DestinationStream): Writable {
  if (destination instanceof Writable) return destination;
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      destination.write(chunk.toString());
      callback();
    },
  });
}

export function createPinoLogger(
  config: AppConfig,
  destination?: DestinationStream,
): Logger {
  // Vitest fija NODE_ENV=test: silencio salvo que la prueba aporte su propio destino.
  const level =
    process.env['NODE_ENV'] === 'test' && destination === undefined ? 'silent' : 'info';
  const common = {
    level,
    messageKey: 'message',
    base: undefined,
    redact: { paths: REDACTED_PATHS, censor: CENSORED },
    mixin: () => {
      const correlationId = currentCorrelationId();
      const documentId = currentDocumentId();
      return {
        ...(correlationId === undefined ? {} : { correlationId }),
        ...(documentId === undefined ? {} : { documentId }),
      };
    },
  };

  if (config.logFormat === 'json') {
    return pino(
      {
        ...common,
        timestamp: () => `,"@timestamp":"${new Date().toISOString()}"`,
        formatters: {
          level: (label) => ({ severity: severityOf(label) }),
          log: formatLog,
        },
      },
      destination,
    );
  }

  // Texto: pino-pretty en el mismo hilo (sin worker), una línea y sin colores.
  const stream = prettyStream({
    colorize: false,
    singleLine: true,
    sync: true,
    messageKey: 'message',
    messageFormat: '[{correlationId}] {message}',
    ignore: 'correlationId',
    destination: destination === undefined ? 1 : asWritable(destination),
  });
  return pino({ ...common, formatters: { log: formatLog } }, stream);
}
