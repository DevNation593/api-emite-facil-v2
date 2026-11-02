import { Injectable, type PipeTransform } from '@nestjs/common';
import { ApiException } from './api-exception.js';

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Un UUID mal formado en la ruta es una petición mal formada (400), no un 404 ni un 500. */
@Injectable()
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !UUID_SHAPE.test(value)) {
      throw new ApiException(400, 'MALFORMED_REQUEST', 'La petición está mal formada');
    }
    return value;
  }
}
