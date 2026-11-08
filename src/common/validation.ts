import {
  SetMetadata,
  ValidationPipe,
  type ArgumentMetadata,
  type ValidationError,
} from '@nestjs/common';
import type { ValidatorOptions } from 'class-validator';
import { ApiException, type FieldError } from './api-exception.js';
import { NOT_NULL_ELEMENTS } from './bean-validation.js';

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

/** La queja de ValidateNested (Valid) cuando el valor no es un objeto ni una lista. */
const NESTED_VALIDATION = 'nestedValidation';

/**
 * `@Valid` de Bean Validation no valida un null; ValidateNested sí se queja. JsonObject y JsonList
 * ya rechazan lo que no es objeto o lista, así que la única queja posible es la de un null (la
 * propiedad o un elemento de la lista), y se descarta junto con los errores que quedan vacíos.
 */
function withoutNullNesting(errors: ValidationError[]): ValidationError[] {
  return errors.flatMap((error) => {
    const constraints = { ...error.constraints };
    if (error.value === null || error.value === undefined) delete constraints[NESTED_VALIDATION];
    const children = withoutNullNesting(error.children ?? []);
    if (Object.keys(constraints).length === 0 && children.length === 0) return [];
    return [{ ...error, constraints, children }];
  });
}

function flatten(
  errors: ValidationError[],
  parent: Array<string | number>,
): FieldError[] {
  return errors.flatMap((error) => {
    const path = [...parent, error.property];
    const own = Object.entries(error.constraints ?? {}).flatMap(([name, message]) => {
      // List<@NotNull …>: un error por elemento null, en campo[i].
      if (name === NOT_NULL_ELEMENTS && Array.isArray(error.value)) {
        return (error.value as unknown[]).flatMap((element, i) =>
          element === null || element === undefined ? [{ field: toSpringFieldPath([...path, i]), message }] : [],
        );
      }
      return [{ field: toSpringFieldPath(path), message }];
    });
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
    // La consulta y la ruta las convierten sus pipes (query-params.ts, UuidPipe) con las reglas de
    // Spring; si este pipe los tocara antes, un parámetro repetido llegaría ya unido con comas.
    if (metadata.type === 'query' || metadata.type === 'param') return value;
    if (metadata.type === 'body' && this.toValidate(metadata) && !isPlainObject(value)) {
      throw new ApiException(400, 'MALFORMED_REQUEST', MALFORMED_BODY);
    }
    return super.transform(value, metadata);
  }

  protected override async validate(object: object, validatorOptions?: ValidatorOptions): Promise<ValidationError[]> {
    return withoutNullNesting(await super.validate(object, validatorOptions));
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
  // flatten necesita el valor de cada error (NotNullElements nombra los elementos null).
  validationError: { target: false, value: true },
  exceptionFactory: (errors) =>
    new ApiException(
      400,
      'VALIDATION_FAILED',
      'La petición no cumple las reglas de validación',
      flatten(errors, []),
    ),
});
