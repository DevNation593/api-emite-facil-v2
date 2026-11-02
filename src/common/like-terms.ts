import { ApiException } from './api-exception.js';
import { strip } from './java-text.js';

export const MAX_TERM_LENGTH = 100;

// `\p{Cntrl}` de Java: solo ASCII (U+0000–U+001F y U+007F).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Prepara un término de búsqueda escrito por el usuario para LIKE con ESCAPE '\', como
 * LikeTerms.java: los comodines y la barra se buscan como texto literal. Un término demasiado largo
 * (en unidades UTF-16, como `length()`) o con caracteres de control se rechaza: la base no acepta el NUL.
 */
export function escapeLike(term: string | undefined): string {
  if (term === undefined) return '';
  if (term.length > MAX_TERM_LENGTH || CONTROL.test(term)) {
    throw new ApiException(
      400,
      'MALFORMED_REQUEST',
      `El término de búsqueda admite hasta ${MAX_TERM_LENGTH} caracteres y ninguno de control`,
    );
  }
  return strip(term).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
