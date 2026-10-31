import request from 'supertest';
import { Controller, Get, Module } from '@nestjs/common';
import { createApp } from '../../src/bootstrap.js';
import { testAuthHeader } from '../support/test-app.js';

@Controller('ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}
@Module({ controllers: [PingController] })
class PingModule {}

it('monta los controladores bajo /api/v1', async () => {
  const app = await createApp({ imports: [PingModule] });
  await app.init();
  await request(app.getHttpServer())
    .get('/api/v1/ping')
    .set('Authorization', await testAuthHeader())
    .expect(200, { ok: true });
  await app.close();
});
