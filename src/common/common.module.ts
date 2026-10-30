import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
} from '@nestjs/common';
import {
  APP_FILTER,
  APP_GUARD,
  APP_PIPE,
  Reflector,
} from '@nestjs/core';
import type { Request } from 'express';
import { ApiException } from './api-exception.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { ACCEPTS_MULTIPART_KEY, validationPipe } from './validation.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** 415 si llega un cuerpo que no es JSON, salvo en handlers con @AcceptsMultipart(). */
@Injectable()
export class JsonContentTypeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!BODY_METHODS.has(req.method)) return true;
    const length = Number(req.headers['content-length'] ?? 0);
    const hasBody = length > 0 || req.headers['transfer-encoding'] !== undefined;
    if (!hasBody) return true;
    const multipart = this.reflector.getAllAndOverride<boolean | undefined>(
      ACCEPTS_MULTIPART_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (multipart === true) return true;
    if (req.is(['application/json', 'application/*+json']) === false) {
      throw new ApiException(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'La petición no se pudo procesar',
      );
    }
    return true;
  }
}

@Module({
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_PIPE, useValue: validationPipe },
    { provide: APP_GUARD, useClass: JsonContentTypeGuard },
  ],
})
export class CommonModule {}
