import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import { ApiException } from './api-exception.js';

const JSON_TYPE = 'application/json';
const SUFFIX_JSON = /^application\/[^*/\s]+\+json$/;

/**
 * El Content-Type de una respuesta JSON según Accept, como el conversor de Jackson en Spring MVC,
 * que escribe application/json y application/*+json: el primer tipo aceptado (por calidad) que sea
 * compatible. null si ninguno lo es (406).
 */
export function negotiateJson(accept: string | undefined): string | null {
  if (accept === undefined || accept.trim() === '') return JSON_TYPE;
  const ranges = accept
    .split(',')
    .map((part, index) => {
      const [type = '', ...params] = part.split(';').map((p) => p.trim().toLowerCase());
      const q = params.find((p) => p.startsWith('q='));
      return { type, quality: q === undefined ? 1 : Number(q.slice(2)), index };
    })
    .filter((range) => range.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { type } of ranges) {
    if (type === '*/*' || type === 'application/*' || type === JSON_TYPE) return JSON_TYPE;
    if (SUFFIX_JSON.test(type)) return type;
  }
  return null;
}

/**
 * Las respuestas JSON llevan el tipo negociado y sin `; charset=utf-8`, como Spring (Express lo
 * añade a todo texto). Un Accept que no admite JSON da 406, después de ejecutar el handler, igual
 * que en Spring. Las respuestas sin cuerpo y las que escribe el handler con @Res() no pasan por aquí.
 */
@Injectable()
export class JsonResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    return next.handle().pipe(
      map((body: unknown) => {
        if (body === undefined || body === null) return body;
        const type = negotiateJson(req.headers.accept);
        if (type === null) {
          throw new ApiException(406, 'REQUEST_REJECTED', 'La petición no se pudo procesar');
        }
        res.setHeader('Content-Type', type);
        // Un Buffer no recibe el charset que res.send añade a los textos.
        res.json = (value: unknown) => res.send(Buffer.from(JSON.stringify(value), 'utf8'));
        return body;
      }),
    );
  }
}
