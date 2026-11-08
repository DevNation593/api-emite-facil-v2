import { negotiateJson } from '../../../src/common/json-response.interceptor.js';

// Tipo de una respuesta JSON según Accept, como Jackson en Spring MVC (application/json y application/*+json).
it.each([
  [undefined, 'application/json'],
  ['', 'application/json'],
  ['application/json', 'application/json'],
  ['*/*', 'application/json'],
  ['application/*', 'application/json'],
  ['application/problem+json', 'application/problem+json'],
  ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'application/json'],
  ['application/json;q=0.5, application/problem+json', 'application/problem+json'],
  ['application/xml', null],
  ['text/plain, application/json;q=0', null],
])('Accept %j da %j', (accept, expected) => {
  expect(negotiateJson(accept)).toBe(expected);
});
