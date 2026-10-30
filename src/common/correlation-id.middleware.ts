import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithContext } from './request-context.js';

export const CORRELATION_ID_HEADER = 'X-Correlation-ID';
const VALID_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Acepta el X-Correlation-ID de la petición si es seguro de registrar y de
 * devolver; si no, genera uno. Debe ir antes que el parseo del cuerpo para
 * que también los errores previos al enrutado lleven el id.
 */
export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header(CORRELATION_ID_HEADER);
  const correlationId =
    incoming !== undefined && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  runWithContext({ correlationId }, next);
}
