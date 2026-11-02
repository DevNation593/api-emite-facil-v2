import { startStack, type StackHandle } from '../../support/containers.js';
import { PASSWORD, startTestApp, type TestApp } from '../../support/test-app.js';

/**
 * Como en Cloud Run: la web pone la IP del navegador, el frente de Google añade la de la web, y
 * lo que haya a la izquierda lo inventa quien llama. El límite es de 20 por minuto y por IP.
 */
const PER_MINUTE = 20;

let stack: StackHandle;
let testApp: TestApp;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack, { EINVOICE_TRUSTED_PROXY_HOPS: '2' });
});
afterAll(async () => {
  await testApp?.close();
  await stack?.stop();
});

/** Cada intento con una primera entrada distinta e inventada: no le sirve para saltarse el límite. */
function loginFrom(ip: string) {
  const forged = `192.0.2.${1 + Math.floor(Math.random() * 250)}`;
  return testApp.http
    .post('/api/v1/auth/login')
    .set('X-Forwarded-For', `${forged}, ${ip}, 10.0.0.1`)
    .send({ email: `u-${Math.random()}@example.test`, password: PASSWORD });
}

it('una dirección que insiste espera y las demás no lo notan', async () => {
  // La ventana es un minuto natural: si queda poco para el siguiente, se espera a que empiece.
  const into = Date.now() % 60_000;
  if (into > 35_000) await new Promise((r) => setTimeout(r, 60_000 - into + 200));

  const ip = `203.0.113.${1 + Math.floor(Math.random() * 200)}`;
  for (let attempt = 0; attempt < PER_MINUTE; attempt++) {
    await loginFrom(ip).expect(401);
  }
  const blocked = await loginFrom(ip).expect(429);
  expect(blocked.headers['retry-after']).toBeDefined();
  expect(blocked.body.errorCode).toBe('RATE_LIMITED');
  await testApp.http
    .post('/api/v1/auth/password-reset/request')
    .set('X-Forwarded-For', `${ip}, 10.0.0.2`)
    .send({ email: 'alguien@example.test' })
    .expect(429);

  await loginFrom('198.51.100.7').expect(401);
});
