import type { NextFunction, Request, Response } from 'express';

/** Las que impiden guardar la respuesta. Spring Security no las pone en un 304. */
export const CACHE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '0',
  ...CACHE_HEADERS,
  'X-Frame-Options': 'DENY',
};

/**
 * Las cabeceras que Spring Security añade por defecto a toda respuesta de Java, también a los errores y a
 * health (sin HSTS: el TLS termina en el proxy). Van primero, para que las lleve quien responda.
 */
export function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  next();
}
