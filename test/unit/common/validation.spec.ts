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
