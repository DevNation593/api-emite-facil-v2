import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { SignJWT } from 'jose';
import type request from 'supertest';
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from '../../../src/config/app-config.js';
import { AccessTokens } from '../../../src/identity/access-tokens.js';
import { FailingModule } from '../../support/failing.controller.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  freshIp,
  mailLink,
  newEmail,
  PASSWORD,
  registerAndLogin,
  startTestApp,
  type TestApp,
} from '../../support/test-app.js';
import { testConfig } from '../../support/test-env.js';

/** Traducción de SecurityIT y de lo que AuthApiIT ejerce con sesión. */
let stack: StackHandle;
let testApp: TestApp;
let tokens: AccessTokens;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack, {}, { imports: [FailingModule] });
  tokens = new AccessTokens(testConfig.auth);
}, 300_000);
afterAll(async () => {
  await testApp?.close();
  await stack?.stop();
});

const http = () => testApp.http;
const bearer = (value: string) => `Bearer ${value}`;
const SECRET = new TextEncoder().encode(testConfig.auth.jwtSecret);

/** Un JWT firmado con la clave de la API pero con las piezas que cada prueba quiera quitar o torcer. */
async function signed(
  options: {
    subject?: string;
    issuer?: string | null;
    audience?: string | null;
    expiresInSeconds?: number | null;
    key?: Uint8Array;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({ sid: randomUUID() })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(options.subject ?? randomUUID())
    .setIssuedAt(now);
  if (options.issuer !== null) jwt = jwt.setIssuer(options.issuer ?? TOKEN_ISSUER);
  if (options.audience !== null) jwt = jwt.setAudience(options.audience ?? TOKEN_AUDIENCE);
  if (options.expiresInSeconds !== null) {
    jwt = jwt.setExpirationTime(now + (options.expiresInSeconds ?? 600));
  }
  return jwt.sign(options.key ?? SECRET);
}

const validLogin = () => ({ email: newEmail(), password: PASSWORD });

describe('sin credenciales', () => {
  it('la salud es pública', async () => {
    await http().get('/actuator/health').expect(200);
  });

  it('la API exige token', async () => {
    const res = await http().get('/api/v1/auth/me').expect(401);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.body).toMatchObject({
      status: 401,
      errorCode: 'UNAUTHENTICATED',
      detail: 'Se requiere un token de acceso válido',
    });
    expect(res.body.correlationId).toBeTruthy();
  });

  it.each([
    [
      'JSON malformado',
      (h: ReturnType<typeof request>) =>
        h.post('/api/v1/tenants').set('Content-Type', 'application/json').send('{'),
    ],
    ['ruta inexistente', (h: ReturnType<typeof request>) => h.get('/api/v1/no-existe')],
    ['ruta fuera de la API', (h: ReturnType<typeof request>) => h.get('/nada')],
    ['raíz', (h: ReturnType<typeof request>) => h.get('/')],
    ['método incorrecto', (h: ReturnType<typeof request>) => h.delete('/api/v1/tenants')],
    [
      'text/plain',
      (h: ReturnType<typeof request>) =>
        h.post('/api/v1/tenants').set('Content-Type', 'text/plain').send('x'),
    ],
    [
      'login con barra final',
      (h: ReturnType<typeof request>) => h.post('/api/v1/auth/login/').send(validLogin()),
    ],
    ['GET a una ruta pública', (h: ReturnType<typeof request>) => h.get('/api/v1/auth/login')],
    ['health con otra ruta', (h: ReturnType<typeof request>) => h.get('/actuator/healthx')],
    ['prometheus', (h: ReturnType<typeof request>) => h.get('/actuator/prometheus')],
  ])('%s da 401', async (_name, call) => {
    const res = await call(http());
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errorCode: 'UNAUTHENTICATED' });
  });

  it('un cuerpo de 11 MB da 401, no 413: no se llega a leer', async () => {
    // Cliente en bruto: superagent puede abortar la escritura al ver cerrarse la respuesta antes de leerla.
    await testApp.app.listen(0);
    const { port } = testApp.app.getHttpServer().address() as AddressInfo;
    const body = Buffer.from(JSON.stringify({ name: 'x'.repeat(11 * 1024 * 1024) }));
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          port,
          method: 'POST',
          path: '/api/v1/tenants',
          headers: { 'content-type': 'application/json', 'content-length': body.length },
        },
        (response) => {
          let text = '';
          response.on('data', (chunk: Buffer) => (text += chunk.toString()));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ errorCode: 'UNAUTHENTICATED' });
  });

  it('POST a /actuator/health da 405, como Spring', async () => {
    const res = await http().post('/actuator/health').expect(405);
    expect(res.body).toMatchObject({ errorCode: 'METHOD_NOT_ALLOWED' });
  });

  it('las rutas públicas de /auth siguen abiertas', async () => {
    await http().post('/api/v1/auth/register').send({ email: newEmail(), password: PASSWORD }).expect(202);
    await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', freshIp())
      .send(validLogin())
      .expect(401)
      .expect((res) => expect(res.body.errorCode).toBe('INVALID_CREDENTIALS'));
  });

  it('el id de correlación se devuelve y se repite en el cuerpo', async () => {
    const res = await http()
      .get('/api/v1/auth/me')
      .set('X-Correlation-ID', 'abc-123')
      .expect(401);
    expect(res.headers['x-correlation-id']).toBe('abc-123');
    expect(res.body.correlationId).toBe('abc-123');
  });

  it.each(['con espacios y\ttab', 'x'.repeat(65), '<script>'])(
    'un id de correlación inseguro (%j) se sustituye',
    async (unsafe) => {
      const res = await http().get('/actuator/health').set('X-Correlation-ID', unsafe);
      expect(res.headers['x-correlation-id']).not.toBe(unsafe);
      expect(res.headers['x-correlation-id']).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    },
  );
});

describe('Authorization: Bearer', () => {
  const rejected = async (token: string, path = '/api/v1/auth/me') => {
    const res = await http().get(path).set('Authorization', bearer(token)).expect(401);
    expect(res.body).toMatchObject({ errorCode: 'UNAUTHENTICATED' });
  };

  it('rechaza un token caducado', async () => {
    const past = new AccessTokens(testConfig.auth, () => new Date(Date.now() - 3_600_000));
    const { value } = await past.issue(randomUUID(), randomUUID(), 'x@example.test', true);
    await rejected(value);
  });

  it('rechaza un token de otro emisor, de otra clave, de otra audiencia, sin audiencia o sin caducidad', async () => {
    await rejected(await signed({ issuer: 'otro-emisor' }));
    await rejected(await signed({ key: new TextEncoder().encode('otra-clave-de-al-menos-32-bytes-por-favor') }));
    await rejected(await signed({ audience: 'otra-aplicacion' }));
    await rejected(await signed({ audience: null }));
    await rejected(await signed({ expiresInSeconds: null }));
  });

  it('rechaza un sujeto en blanco', async () => {
    await rejected(await signed({ subject: ' ' }));
  });

  it('rechaza un token bien firmado de quien no es un usuario', async () => {
    for (const subject of [randomUUID(), 'u-no-es-un-id']) {
      await rejected(await signed({ subject }));
    }
  });

  it('un token válido con un sid que no es un UUID da 401', async () => {
    const { value } = await tokens.issue(randomUUID(), 'no-es-un-uuid', 'x@example.test', true);
    await rejected(value);
  });

  it('un Bearer inválido en una ruta pública da 401', async () => {
    await http()
      .post('/api/v1/auth/login')
      .set('Authorization', 'Bearer x')
      .send(validLogin())
      .expect(401);
  });

  it('un Bearer inválido en /actuator/health da 401', async () => {
    await http().get('/actuator/health').set('Authorization', 'Bearer x').expect(401);
  });

  it('un token válido en una ruta pública se acepta', async () => {
    const { accessToken } = await registerAndLogin(http());
    await http()
      .post('/api/v1/auth/login')
      .set('Authorization', bearer(accessToken))
      .set('X-Forwarded-For', freshIp())
      .send(validLogin())
      .expect(401)
      .expect((res) => expect(res.body.errorCode).toBe('INVALID_CREDENTIALS'));
    await http().get('/actuator/health').set('Authorization', bearer(accessToken)).expect(200);
  });

  it('el esquema se reconoce sin distinguir mayúsculas; uno mal formado da 401', async () => {
    const { accessToken } = await registerAndLogin(http());
    await http().get('/api/v1/auth/me').set('Authorization', `bearer ${accessToken}`).expect(200);
    await http().get('/api/v1/auth/me').set('Authorization', `BEARER ${accessToken}`).expect(200);
    for (const header of ['Bearer', 'Bearer ', 'Bearerx abc', `Bearer ${accessToken} extra`, 'Bearer a b']) {
      await http().get('/api/v1/auth/me').set('Authorization', header).expect(401);
    }
  });

  it('otro esquema se ignora: sin credenciales, la ruta pública pasa y la protegida da 401', async () => {
    await http().get('/actuator/health').set('Authorization', 'Basic YTpi').expect(200);
    await http()
      .post('/api/v1/auth/login')
      .set('Authorization', 'Basic YTpi')
      .set('X-Forwarded-For', freshIp())
      .send(validLogin())
      .expect(401)
      .expect((res) => expect(res.body.errorCode).toBe('INVALID_CREDENTIALS'));
    await http().get('/api/v1/auth/me').set('Authorization', 'Basic YTpi').expect(401);
  });

  it('con token válido, una ruta inexistente da 404', async () => {
    const { accessToken } = await registerAndLogin(http());
    const auth = bearer(accessToken);
    await http().get('/api/v1/no-existe').set('Authorization', auth).expect(404);
    for (const path of ['/nada', '/']) {
      const res = await http().get(path).set('Authorization', auth).expect(404);
      expect(res.body).toMatchObject({ errorCode: 'NOT_FOUND' });
    }
  });

  it('con token válido el 415 y el JSON malformado llegan a su respuesta', async () => {
    const { accessToken } = await registerAndLogin(http());
    const auth = bearer(accessToken);
    await http()
      .post('/api/v1/auth/password')
      .set('Authorization', auth)
      .set('Content-Type', 'text/plain')
      .send('x')
      .expect(415);
    await http()
      .post('/api/v1/auth/password')
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
  });

  it('un error inesperado se registra con su id de correlación', async () => {
    const { accessToken } = await registerAndLogin(http());
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      const res = await http()
        .get('/api/v1/test/boom')
        .set('Authorization', bearer(accessToken))
        .set('X-Correlation-ID', 'corr-500-test')
        .expect(500);
      expect(res.body).toMatchObject({ errorCode: 'INTERNAL_ERROR', correlationId: 'corr-500-test' });
      expect(res.body.detail).not.toContain('provocado');
      expect(lines.some((l) => l.includes('Error no controlado'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('el Authorization nunca llega a los logs', async () => {
    const { accessToken } = await registerAndLogin(http());
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
      }),
    );
    try {
      await http().get('/api/v1/auth/me').set('Authorization', bearer(accessToken)).expect(200);
      await http().get('/api/v1/auth/me').set('Authorization', 'Bearer x.y.z').expect(401);
      await http().get('/api/v1/test/boom').set('Authorization', bearer(accessToken)).expect(500);
      const all = lines.join('\n');
      expect(all).not.toContain(accessToken);
      expect(all).not.toContain('x.y.z');
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

describe('cuenta con sesión (AuthApiIT)', () => {
  it('se crea, se confirma y se usa', async () => {
    const email = newEmail();
    await http().post('/api/v1/auth/register').send({ email, password: PASSWORD }).expect(202);
    const login = await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', freshIp())
      .send({ email, password: PASSWORD })
      .expect(200);
    const auth = bearer(login.body.accessToken as string);

    // Se puede entrar antes de confirmar el correo.
    const before = await http().get('/api/v1/auth/me').set('Authorization', auth).expect(200);
    expect(before.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      email,
      emailVerified: false,
    });

    const link = await mailLink(testApp.smtp, email, 1);
    expect(link.path).toBe('/verify-email');
    expect(link.subject).toBe('Confirma tu correo');
    await http()
      .post('/api/v1/auth/email-verification')
      .send({ token: link.token })
      .expect(204);
    const after = await http().get('/api/v1/auth/me').set('Authorization', auth).expect(200);
    expect(after.body.emailVerified).toBe(true);
    // El enlace sirve una vez.
    const again = await http()
      .post('/api/v1/auth/email-verification')
      .send({ token: link.token })
      .expect(400);
    expect(again.body.errorCode).toBe('INVALID_LINK');
  });

  it('cambiar la contraseña conserva esta sesión y cierra las demás', async () => {
    const email = newEmail();
    const here = await registerAndLogin(http(), email);
    const elsewhere = await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', freshIp())
      .send({ email, password: PASSWORD })
      .expect(200);
    const auth = bearer(here.accessToken);
    const refresh = (token: string) =>
      http().post('/api/v1/auth/refresh').set('X-Forwarded-For', freshIp()).send({ refreshToken: token });

    const wrong = await http()
      .post('/api/v1/auth/password')
      .set('Authorization', auth)
      .send({ currentPassword: 'no es', newPassword: 'la contraseña nueva' })
      .expect(422);
    expect(wrong.body.errorCode).toBe('INVALID_CURRENT_PASSWORD');
    await http()
      .post('/api/v1/auth/password')
      .set('Authorization', auth)
      .send({ currentPassword: PASSWORD, newPassword: 'la contraseña nueva' })
      .expect(204);

    await refresh(here.refreshToken).expect(200);
    await refresh(elsewhere.body.refreshToken as string).expect(401);
    await http()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', freshIp())
      .send({ email, password: 'la contraseña nueva' })
      .expect(200);
  });

  it('el enlace de confirmación se reenvía solo con sesión', async () => {
    const { accessToken, email } = await registerAndLogin(http());
    await mailLink(testApp.smtp, email, 1);

    await http().post('/api/v1/auth/email-verification/resend').expect(401);
    await http().get('/api/v1/auth/me').expect(401);
    await http()
      .post('/api/v1/auth/email-verification/resend')
      .set('Authorization', bearer(accessToken))
      .expect(202);
    const again = await mailLink(testApp.smtp, email, 2);
    await http().post('/api/v1/auth/email-verification').send({ token: again.token }).expect(204);
  });
});

describe('límite de peticiones', () => {
  it('un usuario autenticado que envía JSON malformado cuenta para el límite', async () => {
    const limited = await startTestApp(stack, {
      EINVOICE_RATE_LIMIT_REQUESTS: '3',
      EINVOICE_RATE_LIMIT_WRITES: '300',
    });
    try {
      // La ventana es un minuto natural: si queda poco para el siguiente, se espera a que empiece.
      const into = Date.now() % 60_000;
      if (into > 45_000) await new Promise((r) => setTimeout(r, 60_000 - into + 200));
      const { accessToken } = await registerAndLogin(limited.http);
      const malformed = () =>
        limited.http
          .post('/api/v1/auth/password')
          .set('Authorization', bearer(accessToken))
          .set('Content-Type', 'application/json')
          .send('{');
      for (let i = 0; i < 3; i++) await malformed().expect(400);
      const blocked = await malformed().expect(429);
      expect(blocked.body).toMatchObject({
        errorCode: 'RATE_LIMITED',
        detail: 'Demasiadas peticiones en poco tiempo; espere unos segundos',
      });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      // Sin identidad no se cuenta: el mismo usuario sin token sigue recibiendo 401.
      await limited.http.get('/api/v1/auth/me').expect(401);
    } finally {
      await limited.close();
    }
  });
});
