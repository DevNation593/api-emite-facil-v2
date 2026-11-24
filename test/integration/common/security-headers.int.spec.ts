import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../../../src/bootstrap.js';
import { FailingModule } from '../../support/failing.controller.js';
import { testAuthHeader } from '../../support/test-app.js';

// Las cabeceras por defecto de Spring Security, que Java pone en toda respuesta. Los valores los fija
// test/golden/http/e5.json.
const SECURITY: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-xss-protection': '0',
  'cache-control': 'no-cache, no-store, max-age=0, must-revalidate',
  pragma: 'no-cache',
  expires: '0',
  'x-frame-options': 'DENY',
};

let app: NestExpressApplication;
let auth: string;
beforeAll(async () => {
  app = await createApp({ imports: [FailingModule] });
  await app.init();
  auth = await testAuthHeader();
});
afterAll(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());
const cases: Array<[string, () => request.Test, number]> = [
  ['una respuesta JSON', () => http().post('/api/v1/test/echo').set('Authorization', auth).send({ name: 'a', lines: [] }), 201],
  ['un 401', () => http().get('/api/v1/documents'), 401],
  ['un 404', () => http().get('/otra').set('Authorization', auth), 404],
  ['un 500', () => http().get('/api/v1/test/boom').set('Authorization', auth), 500],
  ['OPTIONS', () => http().options('/api/v1/test/boom').set('Authorization', auth), 200],
  ['health', () => http().get('/actuator/health/liveness'), 200],
];

it.each(cases)('%s lleva las cabeceras de seguridad', async (_name, send, status) => {
  const res = await send();
  expect(res.status).toBe(status);
  expect(res.headers).toMatchObject(SECURITY);
  expect(res.headers['strict-transport-security']).toBeUndefined();
});
