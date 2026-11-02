import { toSpringFieldPath } from '../../../src/common/validation.js';

it('formatea índices como Spring', () => {
  expect(toSpringFieldPath(['lines', 0, 'quantity'])).toBe('lines[0].quantity');
});

it('une propiedades anidadas con punto', () => {
  expect(toSpringFieldPath(['buyer', 'email'])).toBe('buyer.email');
});

it('acepta índices como texto (class-validator)', () => {
  expect(toSpringFieldPath(['lines', '1', 'quantity'])).toBe('lines[1].quantity');
});

describe('consulta y ruta', () => {
  it('el pipe global no convierte: un parámetro repetido llega como lista a su pipe', async () => {
    const { validationPipe } = await import('../../../src/common/validation.js');
    expect(await validationPipe.transform(['a', 'b'], { type: 'query', metatype: String, data: 'q' })).toEqual([
      'a',
      'b',
    ]);
    expect(await validationPipe.transform('5', { type: 'param', metatype: Number, data: 'id' })).toBe('5');
  });
});
