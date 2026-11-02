import { ApiException } from '../../../src/common/api-exception.js';
import { escapeLike } from '../../../src/common/like-terms.js';
import { MAX_PAGE, MAX_PAGE_SIZE, pageRequest } from '../../../src/common/pagination.js';

const RANGE = 'page debe estar entre 0 y 100000 y size entre 1 y 100';

it('calcula el desplazamiento de la página', () => {
  expect(pageRequest(2, 20)).toEqual({ page: 2, size: 20, offset: 40 });
  expect(pageRequest(0, 1)).toEqual({ page: 0, size: 1, offset: 0 });
  expect(pageRequest(MAX_PAGE, MAX_PAGE_SIZE)).toEqual({ page: 100_000, size: 100, offset: 10_000_000 });
});

it.each([
  [-1, 20],
  [100_001, 20],
  [0, 0],
  [0, 101],
])('page %i y size %i fuera de rango dan 400', (page, size) => {
  expect(() => pageRequest(page, size)).toThrow(ApiException);
  try {
    pageRequest(page, size);
  } catch (e) {
    expect(e).toMatchObject({ status: 400, errorCode: 'MALFORMED_REQUEST', detail: RANGE });
  }
});

describe('escapeLike', () => {
  const TERM = 'El término de búsqueda admite hasta 100 caracteres y ninguno de control';

  it('recorta y escapa los comodines y la barra', () => {
    expect(escapeLike(' 50%_a\\b ')).toBe('50\\%\\_a\\\\b');
    expect(escapeLike(undefined)).toBe('');
    expect(escapeLike('')).toBe('');
  });

  it('cuenta unidades UTF-16 antes de recortar, como length()', () => {
    expect(escapeLike('a'.repeat(100))).toBe('a'.repeat(100));
    expect(escapeLike(` ${'a'.repeat(99)}`)).toBe('a'.repeat(99));
    expect(() => escapeLike('😀'.repeat(51))).toThrow(ApiException);
  });

  it.each(['a'.repeat(101), 'a\u0001', 'a\n', '\u007f'])('rechaza %j', (term) => {
    try {
      escapeLike(term);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ status: 400, errorCode: 'MALFORMED_REQUEST', detail: TERM });
    }
  });
});
