import { EventEmitter, Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { jsonBodyMiddleware, UnreadableBody } from '../../../src/common/json-body.js';

/** Una petición con ese cuerpo JSON, como la ve el middleware. */
function request(method: string, path: string, body: string): Request {
  const stream = Readable.from([Buffer.from(body, 'utf8')]) as unknown as Request;
  Object.assign(stream, {
    method,
    path,
    url: path,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
  });
  return stream;
}

const response = () => Object.assign(new EventEmitter(), { getHeader: () => 'corr-1' }) as unknown as Response;

const run = (req: Request) =>
  new Promise<unknown>((resolve) => jsonBodyMiddleware(req, response(), (error?: unknown) => resolve(error)));

it.each(['GET', 'HEAD', 'DELETE', 'OPTIONS'])(
  '%s no lee el cuerpo, como los manejadores sin @RequestBody',
  async (method) => {
    const req = request(method, '/api/v1/customers/1', '{');
    expect(await run(req)).toBeUndefined();
    expect(req.body).toBeUndefined();
  },
);

it('POST /documents/{id}/retry tampoco', async () => {
  const req = request('POST', '/api/v1/documents/1/retry', '{');
  expect(await run(req)).toBeUndefined();
  expect(req.body).toBeUndefined();
});

it.each(['POST', 'PUT', 'PATCH'])('%s con JSON ilegible sigue: el error salta al leer el cuerpo', async (method) => {
  const req = request(method, '/api/v1/customers', '{');
  expect(await run(req)).toBeUndefined();
  expect(req.body).toBeInstanceOf(UnreadableBody);
  expect((req.body as UnreadableBody).error).toMatchObject({
    status: 400,
    errorCode: 'MALFORMED_REQUEST',
    detail: 'El cuerpo de la petición no es JSON válido',
  });
});

it('un cuerpo legible llega leído', async () => {
  const req = request('POST', '/api/v1/customers', '{"a":1}');
  expect(await run(req)).toBeUndefined();
  expect(req.body).toEqual({ a: 1 });
});
