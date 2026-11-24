import express, { type NextFunction, type Request, type Response } from 'express';
import { ApiException } from './api-exception.js';
import { CORRELATION_ID_HEADER } from './correlation-id.middleware.js';
import { recordNumberSource } from './json-source.js';
import { runWithContext } from './request-context.js';

export const JSON_BODY_LIMIT = '10mb';

const parseJson = express.json({
  limit: JSON_BODY_LIMIT,
  type: ['application/json', 'application/*+json'],
  // Cualquier valor JSON es legible, como en Jackson: un `null` vale donde el cuerpo es opcional, y lo que no es un
  // objeto lo rechaza SpringValidationPipe.
  strict: false,
  // Anota el texto de cada número: Jackson lo lee del texto, no del double (json-source.ts).
  reviver: recordNumberSource,
});

/**
 * Lo que queda en `req.body` cuando el cuerpo no se pudo leer. El error no salta en el middleware sino al
 * leer el cuerpo (SpringValidationPipe): en Spring, que la ruta exista, el acceso a la empresa y los
 * parámetros de la ruta se comprueban antes que el `@RequestBody`, y quien no lo declara nunca lo ve.
 */
export class UnreadableBody {
  constructor(readonly error: ApiException) {}
}

/** Métodos cuyos manejadores de Java nunca declaran `@RequestBody`. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

/**
 * Rutas de escritura cuyo manejador en Java no tiene `@RequestBody`: Spring no lee el cuerpo, así que uno
 * ilegible no es un error. Aquí tampoco se lee.
 */
const BODYLESS_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/api\/v1\/documents\/[^/]+\/retry$/ },
];

const bodyless = (req: Request) =>
  BODYLESS_METHODS.has(req.method) ||
  BODYLESS_ROUTES.some((route) => route.method === req.method && route.path.test(req.path));

/**
 * Parser JSON propio (el de Nest se desactiva): los errores de body-parser se
 * traducen aquí, porque Nest los degradaría a un 400 genérico sin distinguir
 * "JSON ilegible" de "cuerpo demasiado grande".
 */
export function jsonBodyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (bodyless(req)) {
    req.body = undefined;
    next();
    return;
  }
  parseJson(req, res, (err?: unknown) => {
    // El contexto abierto por el middleware de correlación se pierde al leer el
    // cuerpo, así que se reabre desde el id que dejó en la respuesta para que
    // guards, pipes, handlers y logs de error lo vean.
    const correlationId = res.getHeader(CORRELATION_ID_HEADER);
    // body-parser deja {} cuando el cuerpo viene vacío; Spring lo trata como cuerpo ausente.
    if (err === undefined && !hasBody(req)) req.body = undefined;
    if (isUnreadable(err)) {
      req.body = new UnreadableBody(new ApiException(400, 'MALFORMED_REQUEST', 'El cuerpo de la petición no es JSON válido'));
      err = undefined;
    }
    const forward = () => next(err === undefined ? undefined : toApiException(err));
    if (typeof correlationId === 'string') runWithContext({ correlationId }, forward);
    else forward();
  });
}

function hasBody(req: Request): boolean {
  return (
    req.headers['transfer-encoding'] !== undefined ||
    (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
  );
}

function isUnreadable(err: unknown): boolean {
  return (err as { type?: string } | null | undefined)?.type === 'entity.parse.failed';
}

function toApiException(err: unknown): unknown {
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.too.large') {
    return new ApiException(413, 'REQUEST_REJECTED', 'La petición no se pudo procesar');
  }
  // Resto (codificación o charset no soportados, abort...): el filtro aplica el mapeo por estado.
  return err;
}
