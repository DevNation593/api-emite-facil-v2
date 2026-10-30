import { STATUS_CODES } from 'node:http';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Application, Request, Response } from 'express';
import { ApiException, type FieldError } from './api-exception.js';
import { CORRELATION_ID_HEADER } from './correlation-id.middleware.js';
import type { ErrorCode } from './error-codes.js';
import { currentCorrelationId } from './request-context.js';
import { allowedMethods } from './route-methods.js';

interface Resolved {
  status: number;
  errorCode: ErrorCode;
  detail: string;
  errors: FieldError[];
  headers: Record<string, string>;
}

const INTERNAL_DETAIL = 'Error interno; use el correlationId para reportarlo';

function defaultErrorCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'MALFORMED_REQUEST';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    default:
      return status < 500 ? 'REQUEST_REJECTED' : 'INTERNAL_ERROR';
  }
}

function defaultDetail(status: number): string {
  switch (status) {
    case 400:
      return 'La petición está mal formada';
    case 404:
      return 'Recurso no encontrado';
    default:
      return status < 500 ? 'La petición no se pudo procesar' : INTERNAL_DETAIL;
  }
}

function clientStatus(exception: unknown): number | undefined {
  // Errores de Express/body-parser (http-errors) que no pasan por Nest.
  const status = (exception as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500
    ? status
    : undefined;
}

/**
 * Convierte toda excepción en application/problem+json con errorCode y
 * correlationId. El detalle es siempre un texto fijo o de validación: nunca
 * el mensaje, la pila ni la clase de la causa.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    if (res.headersSent) return;

    const resolved = this.resolve(exception, req);
    const correlationId =
      (res.getHeader(CORRELATION_ID_HEADER) as string | undefined) ??
      currentCorrelationId() ??
      '';

    const body = {
      type: 'about:blank',
      title: STATUS_CODES[resolved.status] ?? 'Error',
      status: resolved.status,
      detail: resolved.detail,
      instance: req.originalUrl.split('?')[0],
      errorCode: resolved.errorCode,
      correlationId,
      ...(resolved.errors.length > 0 ? { errors: resolved.errors } : {}),
    };

    res.status(resolved.status);
    for (const [name, value] of Object.entries(resolved.headers)) {
      res.setHeader(name, value);
    }
    res.setHeader('Content-Type', 'application/problem+json');
    res.send(JSON.stringify(body));
  }

  private resolve(exception: unknown, req: Request): Resolved {
    if (exception instanceof ApiException) {
      return {
        status: exception.status,
        errorCode: exception.errorCode,
        detail: exception.detail,
        errors: exception.errors,
        headers:
          exception.retryAfterSeconds > 0
            ? { 'Retry-After': String(exception.retryAfterSeconds) }
            : {},
      };
    }

    if (exception instanceof HttpException) {
      return this.fromStatus(exception.getStatus(), req);
    }
    const status = clientStatus(exception);
    if (status !== undefined) {
      return this.fromStatus(status, req);
    }

    this.logger.error(
      'Error no controlado',
      exception instanceof Error ? exception.stack : String(exception),
    );
    return this.fromStatus(500, req);
  }

  private fromStatus(status: number, req: Request): Resolved {
    let headers: Record<string, string> = {};
    if (status === 404) {
      // Express 5 no distingue 404 de 405: lo decide el router.
      const allowed = this.allowed(req);
      if (
        allowed.length > 0 &&
        !allowed.includes(req.method) &&
        req.method !== 'OPTIONS'
      ) {
        status = 405;
        headers = { Allow: allowed.join(', ') };
      }
    }
    return {
      status,
      errorCode: defaultErrorCode(status),
      detail: defaultDetail(status),
      errors: [],
      headers,
    };
  }

  private allowed(req: Request): string[] {
    const app = this.adapterHost.httpAdapter.getInstance() as Application;
    // originalUrl: bajo el prefijo global Nest monta el handler y req.path llega recortado.
    return allowedMethods(app, req.originalUrl.split('?')[0]);
  }
}
