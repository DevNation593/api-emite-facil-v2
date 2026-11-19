import { readFileSync } from 'node:fs';
import { parseAuthorization, parseReception } from '../../src/sri/sri-response-parser.js';
import type { AuthorizationResult, ReceptionResult } from '../../src/sri/sri-results.js';
import { authorizationRequest, receptionRequest } from '../../src/sri/sri-soap-requests.js';

// Peticiones de SriSoapRequests y resultados de SriResponseParser de Java (tools/golden-generator, familia sri).
interface Json<T> {
  [key: string]: unknown;
  rawResponse: string | null;
  value?: T;
}

interface Golden {
  requests: {
    reception: Array<{ file: string; request: string }>;
    authorization: Array<{ accessKey: string | null; request: string | null; error: string | null }>;
  };
  responses: Array<{ name: string; body: string; reception: Json<ReceptionResult>; authorization: Json<AuthorizationResult> }>;
}

const golden = JSON.parse(readFileSync(new URL('./sri.json', import.meta.url), 'utf8')) as Golden;

/** El resultado como lo escribe el generador: el Buffer en Base64. */
const asJson = (result: ReceptionResult | AuthorizationResult) => ({
  ...result,
  rawResponse: result.rawResponse === null ? null : result.rawResponse.toString('base64'),
});

it('el golden trae peticiones y respuestas', () => {
  expect(golden.requests.reception.length).toBeGreaterThanOrEqual(3);
  expect(golden.requests.authorization.some((c) => c.error !== null)).toBe(true);
  expect(golden.responses.length).toBeGreaterThanOrEqual(60);
});

it.each(golden.requests.reception.map((c) => [c.file, c] as const))('recepción de %s byte a byte', (_file, c) => {
  const request = receptionRequest(readFileSync(new URL(c.file, import.meta.url)));
  expect(request.toString('base64')).toBe(c.request);
});

it.each(golden.requests.authorization.map((c) => [String(c.accessKey), c] as const))(
  'autorización de la clave %s',
  (_key, c) => {
    if (c.error !== null) {
      expect(() => authorizationRequest(c.accessKey)).toThrow(c.error);
      return;
    }
    expect(authorizationRequest(c.accessKey).toString('base64')).toBe(c.request);
  },
);

it.each(golden.responses.map((c) => [c.name, c] as const))('respuesta %s', (_name, c) => {
  const body = Buffer.from(c.body, 'base64');
  expect(asJson(parseReception(body))).toEqual(c.reception);
  expect(asJson(parseAuthorization(body))).toEqual(c.authorization);
});
