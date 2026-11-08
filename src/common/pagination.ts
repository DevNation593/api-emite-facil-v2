import { ApiException } from './api-exception.js';

/** Página de resultados de un listado, como PageResponse.java. */
export interface PageResponse<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
}

export const MAX_PAGE_SIZE = 100;

/** Más allá de esta página no hay nada que mostrar y el desplazamiento desborda. */
export const MAX_PAGE = 100_000;

/** Valida los parámetros de paginación recibidos por la API. */
export function pageRequest(page: number, size: number): { page: number; size: number; offset: number } {
  if (page < 0 || page > MAX_PAGE || size < 1 || size > MAX_PAGE_SIZE) {
    throw new ApiException(
      400,
      'MALFORMED_REQUEST',
      `page debe estar entre 0 y ${MAX_PAGE} y size entre 1 y ${MAX_PAGE_SIZE}`,
    );
  }
  return { page, size, offset: page * size };
}
