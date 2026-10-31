import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { ApiException } from './api-exception.js';
import { ACCEPTS_MULTIPART_KEY } from './validation.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * 415 si llega un cuerpo que no es JSON, salvo en handlers con @AcceptsMultipart(). Es un
 * interceptor y no un guard para que corra después de los guards de seguridad: Spring decide
 * 401 y 403 antes que el tipo de contenido.
 */
@Injectable()
export class JsonContentTypeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    if (BODY_METHODS.has(req.method)) {
      const length = Number(req.headers['content-length'] ?? 0);
      const hasBody = length > 0 || req.headers['transfer-encoding'] !== undefined;
      const multipart = this.reflector.getAllAndOverride<boolean | undefined>(
        ACCEPTS_MULTIPART_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (
        hasBody &&
        multipart !== true &&
        req.is(['application/json', 'application/*+json']) === false
      ) {
        throw new ApiException(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'La petición no se pudo procesar',
        );
      }
    }
    return next.handle();
  }
}
