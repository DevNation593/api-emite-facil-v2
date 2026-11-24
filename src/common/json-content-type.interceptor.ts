import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { ApiException } from './api-exception.js';
import { UnreadableBody } from './json-body.js';
import { ACCEPTS_MULTIPART_KEY } from './validation.js';

/** application/json o application/*+json, con o sin parámetros. */
const JSON_MEDIA_TYPE = /^\s*application\/(?:json|[^;\s/]+\+json)\s*(?:;|$)/i;

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Si el handler declara @Body(). Spring solo da 415 al convertir un @RequestBody: un handler que
 * no lee el cuerpo lo ignora, llegue con el tipo que llegue.
 */
function readsBody(context: ExecutionContext): boolean {
  const args = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    context.getClass(),
    context.getHandler().name,
  ) as Record<string, unknown> | undefined;
  return Object.keys(args ?? {}).some((key) =>
    key.startsWith(`${RouteParamtypes.BODY}:`),
  );
}

/**
 * 415 si llega un cuerpo que no es JSON, o ninguno con un tipo que no lo es, salvo en handlers con @AcceptsMultipart(). Es un
 * interceptor y no un guard para que corra después de los guards de seguridad: Spring decide
 * 401 y 403 antes que el tipo de contenido.
 */
@Injectable()
export class JsonContentTypeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    if (BODY_METHODS.has(req.method) && readsBody(context)) {
      const length = Number(req.headers['content-length'] ?? 0);
      const hasBody = length > 0 || req.headers['transfer-encoding'] !== undefined;
      const contentType = req.headers['content-type'] ?? '';
      const multipart = this.reflector.getAllAndOverride<boolean | undefined>(
        ACCEPTS_MULTIPART_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (
        (hasBody || contentType !== '') &&
        multipart !== true &&
        !JSON_MEDIA_TYPE.test(contentType)
      ) {
        // Salta al leer el cuerpo, después de los parámetros de la ruta, como en Spring.
        req.body = new UnreadableBody(
          new ApiException(415, 'UNSUPPORTED_MEDIA_TYPE', 'La petición no se pudo procesar'),
        );
      }
    }
    return next.handle();
  }
}
