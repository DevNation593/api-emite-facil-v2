import { ApiException } from '../common/api-exception.js';
import { strip } from '../common/java-text.js';

/** Cabecera con la clave de idempotencia de toda emisión. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * 400 si falta la cabecera o no tiene el formato admitido (InvoiceController.requireIdempotencyKey). Node,
 * como Tomcat, quita los espacios de alrededor del valor y une con comas una cabecera repetida, que
 * entonces no es válida.
 */
export function requireIdempotencyKey(key: string | undefined): asserts key is string {
  if (key === undefined || strip(key) === '') {
    throw new ApiException(400, 'IDEMPOTENCY_KEY_REQUIRED', `La emisión requiere la cabecera ${IDEMPOTENCY_HEADER}`);
  }
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new ApiException(
      400,
      'IDEMPOTENCY_KEY_INVALID',
      `La cabecera ${IDEMPOTENCY_HEADER} admite hasta 100 caracteres: letras, dígitos y . _ : -`,
    );
  }
}
