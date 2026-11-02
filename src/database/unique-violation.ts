/**
 * Si el error de pg es una violación de unicidad (23505) de esa restricción o índice. Equivale a
 * buscar el nombre en `DataIntegrityViolationException` de Java: la restricción de la base decide,
 * también cuando dos peticiones compiten.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const found = error as { code?: unknown; constraint?: unknown };
  return found.code === '23505' && found.constraint === constraint;
}
