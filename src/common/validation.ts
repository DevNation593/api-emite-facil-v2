import { SetMetadata, ValidationPipe, type ValidationError } from '@nestjs/common';
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

export const validationPipe = new ValidationPipe({
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
