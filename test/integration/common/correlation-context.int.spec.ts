import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import {
  type CanActivate,
  Body,
  Controller,
  Injectable,
  Module,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../../../src/bootstrap.js';
import { currentCorrelationId } from '../../../src/common/request-context.js';
import { testAuthHeader } from '../../support/test-app.js';

const seen: Array<string | undefined> = [];

@Injectable()
class RecordingGuard implements CanActivate {
  canActivate(): boolean {
    seen.push(currentCorrelationId());
    return true;
  }
}

@Controller('ctx')
@UseGuards(RecordingGuard)
class CtxController {
  @Post()
  post(@Body() body: unknown) {
    seen.push(currentCorrelationId());
    return body;
  }
}
@Module({ controllers: [CtxController] })
class CtxModule {}

let app: NestExpressApplication;
let auth: string;
beforeAll(async () => {
  app = await createApp({ imports: [CtxModule] });
  await app.init();
  auth = await testAuthHeader();
});
afterAll(async () => {
  await app.close();
});

it('el correlationId llega a los guards de una petición con cuerpo JSON', async () => {
  seen.length = 0;
  const res = await request(app.getHttpServer())
    .post('/api/v1/ctx')
    .set('Authorization', auth)
    .set('X-Correlation-ID', 'guard-77')
    .send({ a: 1 })
    .expect(201);
  expect(res.headers['x-correlation-id']).toBe('guard-77');
  expect(seen).toEqual(['guard-77', 'guard-77']); // guard y handler
});

it('también cuando el cuerpo llega troceado y con retraso', async () => {
  seen.length = 0;
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      {
        port,
        method: 'POST',
        path: '/api/v1/ctx',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': 'slow-1',
          authorization: auth,
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.write('{"a":');
    setTimeout(() => req.end('1}'), 50);
  });
  expect(seen).toEqual(['slow-1', 'slow-1']);
});
