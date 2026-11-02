import {
  SetMetadata,
  ValidationPipe,
  type ArgumentMetadata,
  type ValidationError,
} from '@nestjs/common';
import { ApiException, type FieldError } from './api-exception.js';

export const ACCEPTS_MULTIPART_KEY = 'common:acceptsMultipart';

/** Exime al handler de la comprobación de Content-Type JSON (p. ej. subida de certificados). */
export const AcceptsMultipart = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ACCEPTS_MULTIPART_KEY, true);

/** ['lines', 0, 'quantity'] → 'lines[0].quantity', como las rutas de campo de Spring. */
export function toSpringFieldPath(path: Array<string | number>): string {
  let result = '';
  for (const segment of path) {
    if (typeof segment === 'number' || /^\d+$/.test(segment)) {
      result += `[${segment}]`;
    } else {
      result += result === '' ? segment : `.${segment}`;
    }
  }
  return result;
}

function flatten(
  errors: ValidationError[],
  parent: Array<string | number>,
): FieldError[] {
  return errors.flatMap((error) => {
    const path = [...parent, error.property];
    const own = Object.values(error.constraints ?? {}).map((message) => ({
      field: toSpringFieldPath(path),
      message,
    }));
    return [...own, ...flatten(error.children ?? [], path)];
  });
}

const MALFORMED_BODY = 'El cuerpo de la petición no es JSON válido';

/**
 * ValidationPipe con las reglas de Spring + Jackson: un cuerpo ausente o que no es un
 * objeto es JSON no legible (400 MALFORMED_REQUEST), y eso se comprueba antes de validar.
 * Los parámetros que no son el cuerpo, y los cuerpos sin DTO, siguen el camino normal.
 */
class SpringValidationPipe extends ValidationPipe {
  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    if (metadata.type === 'body' && this.toValidate(metadata) && !isPlainObject(value)) {
      throw new ApiException(400, 'MALFORMED_REQUEST', MALFORMED_BODY);
    }
    return super.transform(value, metadata);
  }
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const validationPipe = new SpringValidationPipe({
  transform: true,
  whitelist: true,
  // Spring/Jackson ignora las propiedades desconocidas en lugar de rechazarlas.
  forbidNonWhitelisted: false,
  forbidUnknownValues: false,
  exceptionFactory: (errors) =>
    new ApiException(
      400,
      'VALIDATION_FAILED',
      'La petición no cumple las reglas de validación',
      flatten(errors, []),
    ),
});
