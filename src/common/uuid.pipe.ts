import { Injectable, type PipeTransform } from '@nestjs/common';
import { ApiException } from './api-exception.js';
import { javaUuidFromString } from './java-uuid.js';
import { javaTrim } from './java-text.js';

/**
 * Un UUID en la ruta, como `@PathVariable UUID` de Spring (StringToUUIDConverter): se recorta y se
 * lee con UUID.fromString, que también admite tramos cortos ("1-2-3-4-5"). Devuelve la forma
 * canónica en minúsculas. Lo que no se lee es una petición mal formada (400), no un 404 ni un 500.
 */
@Injectable()
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const id = typeof value === 'string' ? javaUuidFromString(javaTrim(value)) : null;
    if (id === null) {
      throw new ApiException(400, 'MALFORMED_REQUEST', 'La petición está mal formada');
    }
    return id;
  }
}
