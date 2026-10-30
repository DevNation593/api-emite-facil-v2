import express, { type NextFunction, type Request, type Response } from 'express';
import { ApiException } from './api-exception.js';

export const JSON_BODY_LIMIT = '10mb';

const parseJson = express.json({
  limit: JSON_BODY_LIMIT,
  type: ['application/json', 'application/*+json'],
});

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
  parseJson(req, res, (err?: unknown) => {
    next(err === undefined ? undefined : toApiException(err));
  });
}

function toApiException(err: unknown): unknown {
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') {
    return new ApiException(
      400,
      'MALFORMED_REQUEST',
      'El cuerpo de la petición no es JSON válido',
    );
  }
  if (type === 'entity.too.large') {
    return new ApiException(413, 'REQUEST_REJECTED', 'La petición no se pudo procesar');
  }
  // Resto (codificación o charset no soportados, abort...): el filtro aplica el mapeo por estado.
  return err;
}
