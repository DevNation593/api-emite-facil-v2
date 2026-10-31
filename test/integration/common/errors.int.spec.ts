import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../../../src/bootstrap.js';
import { FailingModule } from '../../support/failing.controller.js';

const problem = (status: number, extra: object) =>
  expect.objectContaining({ type: 'about:blank', status, ...extra });

let app: NestExpressApplication;
let http: ReturnType<typeof request>;

beforeAll(async () => {
  app = await createApp({ imports: [FailingModule] });
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app.close();
});

it('ruta inexistente', async () => {
  const res = await http.get('/api/v1/no-existe?x=1').set('X-Correlation-ID', 'abc-123');
  expect(res.status).toBe(404);
  expect(res.headers['content-type']).toBe('application/problem+json');
  expect(res.headers['etag']).toBeUndefined();
  expect(res.headers['x-powered-by']).toBeUndefined();
  expect(res.body).toEqual({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: 'Recurso no encontrado',
    instance: '/api/v1/no-existe',
    errorCode: 'NOT_FOUND',
    correlationId: 'abc-123',
  });
});

it.each(['/nada', '/', '/api', '/api/v2/x', '/actuatorx'])(
  'ruta fuera de /api/v1 y /actuator (%s) da 404 problem+json',
  async (path) => {
    const res = await http.get(path).set('X-Correlation-ID', 'fuera-1');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.body).toEqual(
      problem(404, {
        errorCode: 'NOT_FOUND',
        instance: path,
        correlationId: 'fuera-1',
      }),
    );
  },
);

it('POST /actuator/health da 405 con Allow', async () => {
  const res = await http.post('/actuator/health');
  expect(res.status).toBe(405);
  expect(res.headers.allow).toContain('GET');
  expect(res.body).toEqual(problem(405, { errorCode: 'METHOD_NOT_ALLOWED' }));
});

it('método no permitido', async () => {
  const res = await http.delete('/api/v1/test/boom');
  expect(res.status).toBe(405);
  expect(res.headers.allow).toContain('GET');
  expect(res.body).toEqual(
    problem(405, {
      errorCode: 'METHOD_NOT_ALLOWED',
      detail: 'La petición no se pudo procesar',
    }),
  );
});

it('JSON ilegible', async () => {
  const res = await http
    .post('/api/v1/test/echo')
    .set('Content-Type', 'application/json')
    .send('{"name":');
  expect(res.status).toBe(400);
  expect(res.headers['x-correlation-id']).toBeTruthy();
  expect(res.body).toEqual(
    problem(400, {
      errorCode: 'MALFORMED_REQUEST',
      detail: 'El cuerpo de la petición no es JSON válido',
      correlationId: res.headers['x-correlation-id'],
    }),
  );
});

it('Content-Type no JSON', async () => {
  const res = await http
    .post('/api/v1/test/echo')
    .set('Content-Type', 'text/plain')
    .send('hola');
  expect(res.status).toBe(415);
  expect(res.body).toEqual(problem(415, { errorCode: 'UNSUPPORTED_MEDIA_TYPE' }));
});

it('POST sin cuerpo no es 415', async () => {
  const res = await http.post('/api/v1/test/echo');
  expect(res.status).not.toBe(415);
});

it('validación con rutas de campo de Spring', async () => {
  const res = await http
    .post('/api/v1/test/echo')
    .send({ name: '', lines: [{ quantity: 1 }, { quantity: -1 }] });
  expect(res.status).toBe(400);
  expect(res.body).toEqual(
    problem(400, {
      errorCode: 'VALIDATION_FAILED',
      detail: 'La petición no cumple las reglas de validación',
      errors: expect.arrayContaining([
        expect.objectContaining({ field: 'name' }),
        expect.objectContaining({ field: 'lines[1].quantity' }),
      ]),
    }),
  );
});

it('ApiException con errores y Retry-After', async () => {
  const res = await http.get('/api/v1/test/api-exception');
  expect(res.status).toBe(422);
  expect(res.headers['retry-after']).toBe('30');
  expect(res.body).toEqual(
    problem(422, {
      title: 'Unprocessable Content',
      errorCode: 'WEAK_PASSWORD',
      detail: 'La contraseña no es válida',
      errors: [{ field: 'password', message: 'x' }],
    }),
  );
});

it('error inesperado no filtra la causa', async () => {
  const res = await http.get('/api/v1/test/boom');
  expect(res.status).toBe(500);
  expect(res.body).toEqual(
    problem(500, {
      errorCode: 'INTERNAL_ERROR',
      detail: 'Error interno; use el correlationId para reportarlo',
    }),
  );
  expect(JSON.stringify(res.body)).not.toMatch(/at |Error:|secreto-interno/);
});

it.each(['a b', 'x'.repeat(65), '', 'a	b', 'a/b'])(
  'X-Correlation-ID inválido %j se reemplaza',
  async (value) => {
    const res = await http.get('/api/v1/no-existe').set('X-Correlation-ID', value);
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
  },
);

it('acepta una factura de 1 000 líneas', async () => {
  const lines = Array.from({ length: 1000 }, () => ({
    quantity: 1,
    description: 'x'.repeat(300),
  }));
  await http.post('/api/v1/test/echo').send({ name: 'grande', lines }).expect(201);
});

it('cuerpo mayor de 10 MB responde 413 problem+json', async () => {
  const res = await http
    .post('/api/v1/test/echo')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ name: 'x'.repeat(11 * 1024 * 1024) }));
  expect(res.status).toBe(413);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(res.body).toEqual(
    problem(413, {
      errorCode: 'REQUEST_REJECTED',
      detail: 'La petición no se pudo procesar',
    }),
  );
  expect(res.body.correlationId).toBeTruthy();
});

it.each([undefined, '[]', '"x"', '5'])('cuerpo %j que no es un objeto', async (body) => {
  const res = await http
    .post('/api/v1/test/echo')
    .set('Content-Type', 'application/json')
    .send(body);
  expect(res.body).toMatchObject({ status: 400, errorCode: 'MALFORMED_REQUEST' });
});

it('objeto donde va un texto es JSON no legible, como Jackson', async () => {
  const res = await http.post('/api/v1/test/echo').send({ name: { a: 1 }, lines: [] });
  expect(res.body).toMatchObject({
    status: 400,
    errorCode: 'MALFORMED_REQUEST',
    detail: 'El cuerpo de la petición no es JSON válido',
  });
});

it('array donde va un texto anidado es JSON no legible', async () => {
  const res = await http
    .post('/api/v1/test/echo')
    .send({ name: 'x', lines: [{ quantity: 1, description: ['a'] }] });
  expect(res.body).toMatchObject({ status: 400, errorCode: 'MALFORMED_REQUEST' });
});

it('número donde va un texto se convierte, como Jackson', async () => {
  const res = await http.post('/api/v1/test/echo').send({ name: 5, lines: [] }).expect(201);
  expect(res.body.name).toBe('5');
});

it('@NotBlank con el recorte de Java: NBSP no cuenta como blanco', async () => {
  await http.post('/api/v1/test/echo').send({ name: String.fromCharCode(0xa0), lines: [] }).expect(201);
  const res = await http
    .post('/api/v1/test/echo')
    .send({ name: String.fromCharCode(0x3000), lines: [] })
    .expect(400);
  expect(res.body.errors).toEqual([{ field: 'name', message: 'must not be blank' }]);
});
