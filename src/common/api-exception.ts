import type { ErrorCode } from './error-codes.js';

export interface FieldError {
  field: string;
  message: string;
}

/** Error de negocio o de acceso que la API devuelve como application/problem+json. */
export class ApiException extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: ErrorCode,
    readonly detail: string,
    readonly errors: FieldError[] = [],
    /** Cabecera Retry-After; 0 si no aplica. */
    readonly retryAfterSeconds = 0,
  ) {
    super(detail);
    this.name = 'ApiException';
  }

  /** Mismo cuerpo para un recurso inexistente y para uno de otro tenant. */
  static notFound(): ApiException {
    return new ApiException(404, 'NOT_FOUND', 'Recurso no encontrado');
  }

  /** 429 con Retry-After en segundos. */
  static tooManyRequests(
    errorCode: ErrorCode,
    detail: string,
    retryAfterSeconds: number,
  ): ApiException {
    return new ApiException(429, errorCode, detail, [], retryAfterSeconds);
  }
}
