import { Writable } from 'node:stream';
import { pino, type DestinationStream, type Logger } from 'pino';
import { build as prettyStream } from 'pino-pretty';
import type { AppConfig } from '../config/app-config.js';
import { currentCorrelationId } from '../common/request-context.js';

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
function flattenError(object: Record<string, unknown>): Record<string, unknown> {
  const { err, ...rest } = object as {
    err?: { message?: string; stack?: string };
    [key: string]: unknown;
  };
  if (err === undefined || typeof err !== 'object') return object;
  if (err.stack !== undefined) rest['stack_trace'] = err.stack;
  if (rest['message'] === undefined && err.message !== undefined) {
    rest['message'] = err.message;
  }
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
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    mixin: () => {
      const correlationId = currentCorrelationId();
      return correlationId === undefined ? {} : { correlationId };
    },
  };

  if (config.logFormat === 'json') {
    return pino(
      {
        ...common,
        timestamp: () => `,"@timestamp":"${new Date().toISOString()}"`,
        formatters: {
          level: (label) => ({ severity: severityOf(label) }),
          log: flattenError,
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
  return pino({ ...common, formatters: { log: flattenError } }, stream);
}
