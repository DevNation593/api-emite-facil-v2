import { expect, it } from 'vitest';
import { reasonPhrase } from '../../../src/common/http-reason.js';

it.each([
  [413, 'Content Too Large'],
  [416, 'Requested range not satisfiable'],
  [418, "I'm a teapot"],
  [422, 'Unprocessable Content'],
  [505, 'HTTP Version not supported'],
  [400, 'Bad Request'],
  [404, 'Not Found'],
  [405, 'Method Not Allowed'],
  [415, 'Unsupported Media Type'],
  [429, 'Too Many Requests'],
  [500, 'Internal Server Error'],
  [599, 'Error'],
])('%i -> %s', (status, title) => {
  expect(reasonPhrase(status)).toBe(title);
});
