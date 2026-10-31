import { Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ApiKeyService } from '../apikey/api-key.service.js';
import { ApiException } from '../common/api-exception.js';
import type { RateLimiter } from '../common/rate-limiter.js';
import type { AccessTokens } from './access-tokens.js';
import {
  type RequestIdentity,
  setIdentity,
  unauthenticated,
} from './request-identity.js';

/** Lo que se hace sin sesión: crear la cuenta, entrar, renovar, salir y los enlaces de los correos. */
export const PUBLIC_AUTH: ReadonlySet<string> = new Set([
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/email-verification',
  '/api/v1/auth/password-reset/request',
  '/api/v1/auth/password-reset',
]);

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Resolutor de Spring (DefaultBearerTokenResolver): el esquema sin distinguir mayúsculas y un
// token de ese alfabeto; algo que empieza por "bearer" y no encaja es un token mal formado.
const BEARER = /^Bearer (?<token>[a-zA-Z0-9\-._~+/]+=*)$/i;

export interface AuthenticationDeps {
  accessTokens: Pick<AccessTokens, 'verify'>;
  apiKeys: Pick<ApiKeyService, 'authenticate' | 'touch'>;
  limiter: Pick<RateLimiter, 'check'>;
}

/** Sin identidad solo pasan estas rutas; EndpointRequest.to("health") no distingue el método. */
function isPublic(req: Request): boolean {
  const path = req.path;
  if (path === '/actuator/health' || path.startsWith('/actuator/health/')) return true;
  return req.method === 'POST' && PUBLIC_AUTH.has(path);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}

/**
 * Sustituye a la cadena de filtros de Spring Security (SecurityConfig, ApiKeyAuthenticationFilter
 * y RateLimitFilter). Va antes de leer el cuerpo: una petición sin credenciales no cuesta ni
 * parseo ni base de datos. Todo fallo sale por next(error) para que responda el filtro de errores.
 */
export function authenticationMiddleware(deps: AuthenticationDeps): RequestHandler {
  const logger = new Logger('Authentication');

  async function identifyApiKey(header: string): Promise<RequestIdentity> {
    let principal;
    try {
      principal = await deps.apiKeys.authenticate(header);
    } catch (error) {
      // Nunca 401: el sistema externo lo leería como una key inválida y podría dejar de llamar.
      // Solo el nombre del error: ni la key ni su hash se registran.
      logger.error(`No se pudo comprobar una API key: ${errorName(error)}`);
      throw new ApiException(
        503,
        'INTERNAL_ERROR',
        'No se pudo comprobar la API key; vuelva a intentar en un momento',
      );
    }
    // La misma respuesta que un token inválido, sea cual sea el motivo.
    if (principal === null) throw unauthenticated();
    try {
      await deps.apiKeys.touch(principal.apiKeyId);
    } catch (error) {
      // El último uso es informativo: un fallo al anotarlo no deja sin servicio una key válida.
      logger.warn(
        `No se pudo anotar el último uso de la API key ${principal.apiKeyId}: ${errorName(error)}`,
      );
    }
    return { kind: 'apiKey', ...principal };
  }

  async function identify(req: Request): Promise<RequestIdentity | null> {
    const apiKey = req.headers['x-api-key'];
    const authorization = req.headers.authorization;
    if (apiKey !== undefined) {
      // Dos credenciales a la vez: no se elige una por el cliente (aunque la key venga vacía).
      if (authorization !== undefined) {
        throw new ApiException(
          400,
          'CREDENTIALS_AMBIGUOUS',
          'Envíe X-Api-Key o Authorization, no las dos',
        );
      }
      // Node junta las cabeceras repetidas con ", ": la key resultante no tendrá el formato.
      return identifyApiKey(Array.isArray(apiKey) ? (apiKey[0] ?? '') : apiKey);
    }
    if (authorization === undefined) return null;
    // Otro esquema (Basic...) no es una credencial para esta API.
    if (authorization.slice(0, 6).toLowerCase() !== 'bearer') return null;
    const token = BEARER.exec(authorization)?.groups?.['token'];
    if (token === undefined) throw unauthenticated();
    const claims = await deps.accessTokens.verify(token);
    if (claims === null) throw unauthenticated();
    return { kind: 'user', userId: claims.sub, sessionId: claims.sid };
  }

  async function handle(req: Request): Promise<void> {
    const identity = await identify(req);
    if (identity === null) {
      if (isPublic(req)) return;
      throw unauthenticated();
    }
    setIdentity(req, identity);
    const subject =
      identity.kind === 'user' ? identity.userId : `apikey:${identity.apiKeyId}`;
    const decision = await deps.limiter.check(subject, !READS.has(req.method));
    if (!decision.allowed) {
      throw ApiException.tooManyRequests(
        'RATE_LIMITED',
        'Demasiadas peticiones en poco tiempo; espere unos segundos',
        decision.retryAfterSeconds,
      );
    }
  }

  return (req: Request, _res: Response, next: NextFunction): void => {
    void handle(req).then(
      () => next(),
      (error: unknown) => next(error),
    );
  };
}
