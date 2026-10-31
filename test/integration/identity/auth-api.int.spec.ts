import net from 'node:net';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import type { Registry } from 'prom-client';
import { AuthMailer } from '../../../src/identity/auth-mailer.js';
import { MAX_EMAILS_PER_HOUR } from '../../../src/identity/auth.service.js';
import { METRICS_REGISTRY } from '../../../src/observability/metrics.js';
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

let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
});
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});

const http = () => testApp.http;
// Una IP distinta por petición: el límite por IP de /auth es de 20 por minuto.
const send = (path: string, body: object) =>
  http().post(`/api/v1/auth${path}`).set('X-Forwarded-For', freshIp()).send(body);
const register = (email: string, password: string = PASSWORD) =>
  send('/register', { email, password });
const login = (email: string, password: string = PASSWORD) =>
  send('/login', { email, password });
const refresh = (refreshToken: string) => send('/refresh', { refreshToken });
const query = async <T extends pg.QueryResultRow>(text: string, params: unknown[]) =>
  (await db.query<T>(text, params)).rows;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const inbox = (email: string) => testApp.smtp.messages().filter((m) => m.to.includes(email));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

it('el ingreso responde con los dos tokens y sus plazos', async () => {
  const email = newEmail();
  await register(email).expect(202);
  const res = await login(email).expect(200);
  expect(typeof res.body.accessToken).toBe('string');
  expect(typeof res.body.refreshToken).toBe('string');
  expect(res.body.expiresIn).toBeGreaterThan(800);
  expect(res.body.expiresIn).toBeLessThanOrEqual(900);
  expect(res.body.refreshExpiresAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  // Solo se guarda el hash de la contraseña, y es Argon2id.
  const [row] = await query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE email = $1',
    [email],
  );
  expect(row!.password_hash).toMatch(/^\$argon2id\$/);
  expect(row!.password_hash).not.toContain(PASSWORD);
});

it('confirmar el correo: el enlace sirve una vez', async () => {
  const email = newEmail();
  await register(email).expect(202);
  const link = await mailLink(testApp.smtp, email, 1);
  expect(link.path).toBe('/verify-email');
  expect(link.subject).toBe('Confirma tu correo');
  await send('/email-verification', { token: link.token }).expect(204);
  const [row] = await query<{ verified: boolean }>(
    'SELECT email_verified_at IS NOT NULL AS verified FROM users WHERE email = $1',
    [email],
  );
  expect(row!.verified).toBe(true);
  const again = await send('/email-verification', { token: link.token }).expect(400);
  expect(again.body.errorCode).toBe('INVALID_LINK');
});

it('el correo se normaliza: registro y login con mayúsculas son la misma cuenta', async () => {
  const email = newEmail();
  await register(email.toUpperCase()).expect(202);
  await login(email).expect(200);
  await login(email.toUpperCase()).expect(200);
  expect(await query('SELECT 1 FROM users WHERE email = $1', [email])).toHaveLength(1);
  // Registrar otra vez con otra grafía no crea una segunda cuenta.
  await register(email).expect(202);
  expect(await query('SELECT 1 FROM users WHERE lower(email) = $1', [email])).toHaveLength(1);
});

it('un correo con espacios no pasa @Email, como en Java: se normaliza después de validar', async () => {
  const res = await register(` ${newEmail()} `).expect(400);
  expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  expect(res.body.errors[0].field).toBe('email');
});

it('registrar un correo que ya tiene cuenta no revela nada ni cambia nada', async () => {
  const email = newEmail();
  await register(email).expect(202);
  await register(email, 'otra contraseña larga').expect(202);
  const link = await mailLink(testApp.smtp, email, 2);
  expect(link.subject).toBe('Ya tienes una cuenta');
  expect(link.path).toBe('/reset-password');
  await login(email, 'otra contraseña larga').expect(401);
  await login(email).expect(200);
});

it('una contraseña equivocada y un correo desconocido se ven igual', async () => {
  const email = newEmail();
  await register(email).expect(202);
  const wrong = await login(email, 'no es la contraseña').expect(401);
  const unknown = await login(newEmail()).expect(401);
  expect(wrong.body.errorCode).toBe('INVALID_CREDENTIALS');
  expect(unknown.body.errorCode).toBe('INVALID_CREDENTIALS');
  expect(unknown.body.detail).toBe(wrong.body.detail);
});

it('cada renovación cambia el token y uno reutilizado cierra la sesión', async () => {
  const first = await registerAndLogin(http());
  const renewed = await refresh(first.refreshToken).expect(200);
  const second = renewed.body.refreshToken as string;
  expect(second).not.toBe(first.refreshToken);
  expect(renewed.body.expiresIn).toBeGreaterThan(800);

  // Alguien presenta el token ya usado: se cierra la sesión, también para quien tiene el bueno.
  const reused = await refresh(first.refreshToken).expect(401);
  expect(reused.body.errorCode).toBe('INVALID_REFRESH_TOKEN');
  await refresh(second).expect(401);
  const [row] = await query<{ revoke_reason: string }>(
    'SELECT revoke_reason FROM auth_sessions WHERE user_id = $1',
    [first.userId],
  );
  // El cierre se confirmó aunque la petición terminara en 401.
  expect(row!.revoke_reason).toBe('TOKEN_REUSED');
});

it('dos renovaciones simultáneas: una entrega tokens y la otra da 401 y cierra la sesión', async () => {
  const { refreshToken, userId } = await registerAndLogin(http());
  const [a, b] = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);
  expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 401]);
  const winner = a.status === 200 ? a : b;
  expect((await refresh(winner.body.refreshToken)).status).toBe(401);
  const [row] = await query<{ revoke_reason: string }>(
    'SELECT revoke_reason FROM auth_sessions WHERE user_id = $1',
    [userId],
  );
  expect(row!.revoke_reason).toBe('TOKEN_REUSED');
});

it('un token de renovación desconocido, o de una sesión caducada, da 401', async () => {
  await refresh('no-existe').expect(401);
  const { refreshToken, userId } = await registerAndLogin(http());
  await db.query(
    "UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1",
    [userId],
  );
  await refresh(refreshToken).expect(401);
});

it('salir cierra la sesión, y salir otra vez o con un token desconocido no es un error', async () => {
  const { refreshToken } = await registerAndLogin(http());
  await send('/logout', { refreshToken }).expect(204);
  await refresh(refreshToken).expect(401);
  await send('/logout', { refreshToken }).expect(204);
  await send('/logout', { refreshToken: 'desconocido' }).expect(204);
});

it('una contraseña olvidada se cambia con el enlace del correo y cierran todas las sesiones', async () => {
  const email = newEmail();
  await register(email).expect(202);
  const open = await login(email).expect(200);

  await send('/password-reset/request', { email }).expect(202);
  const link = await mailLink(testApp.smtp, email, 2);
  expect(link.path).toBe('/reset-password');
  const weak = await send('/password-reset', {
    token: link.token,
    newPassword: 'corta',
  }).expect(422);
  expect(weak.body.errorCode).toBe('WEAK_PASSWORD');
  expect(weak.body.errors[0].field).toBe('newPassword');
  // Un intento con una contraseña rechazada no gasta el enlace.
  await send('/password-reset', {
    token: link.token,
    newPassword: 'la contraseña nueva',
  }).expect(204);

  await login(email).expect(401);
  await login(email, 'la contraseña nueva').expect(200);
  await refresh(open.body.refreshToken).expect(401);
  await send('/password-reset', {
    token: link.token,
    newPassword: 'otra contraseña más',
  }).expect(400);
  // Recibir el enlace demuestra que el correo es suyo.
  const [row] = await query<{ verified: boolean }>(
    'SELECT email_verified_at IS NOT NULL AS verified FROM users WHERE email = $1',
    [email],
  );
  expect(row!.verified).toBe(true);
});

it('pedir cambiar la contraseña de un correo desconocido se ve igual y no envía nada', async () => {
  const email = newEmail();
  await send('/password-reset/request', { email }).expect(202);
  await sleep(500);
  expect(inbox(email)).toHaveLength(0);
});

it('los fallos repetidos bloquean el correo un tiempo', async () => {
  const email = newEmail();
  await register(email).expect(202);
  for (let attempt = 1; attempt < 5; attempt++) {
    await login(email, 'no es la contraseña').expect(401);
  }
  const locked = await login(email, 'no es la contraseña').expect(429);
  expect(locked.headers['retry-after']).toBeDefined();
  expect(locked.body.errorCode).toBe('ACCOUNT_LOCKED');
  // Ni con la contraseña buena, mientras dure el bloqueo.
  await login(email).expect(429);
});

it('las contraseñas débiles se rechazan', async () => {
  const email = newEmail();
  const weak = await register(email, 'corta').expect(422);
  expect(weak.body.errorCode).toBe('WEAK_PASSWORD');
  expect(weak.body.errors[0].field).toBe('password');
  await register(email, email).expect(422);
  await register(email, 'x'.repeat(129)).expect(422);
  // Una cadena vacía pasa @NotNull y la regla de la contraseña la rechaza.
  await register(email, '').expect(422);
  await login(email, 'corta').expect(401);
});

it('no más de unos correos por hora llegan a la misma bandeja', async () => {
  const email = newEmail();
  await register(email).expect(202);
  for (let i = 0; i < MAX_EMAILS_PER_HOUR + 3; i++) {
    await send('/password-reset/request', { email }).expect(202);
  }
  // 1 de confirmación + MAX de recuperación: el límite cuenta por tipo de enlace.
  await mailLink(testApp.smtp, email, 1 + MAX_EMAILS_PER_HOUR);
  await sleep(500);
  expect(inbox(email)).toHaveLength(1 + MAX_EMAILS_PER_HOUR);
});

it('con SMTP caído el registro responde 202 y la cuenta existe', async () => {
  const down = await startTestApp(stack, { SPRING_MAIL_PORT: String(await freePort()) });
  try {
    const email = newEmail();
    await down.http.post('/api/v1/auth/register').send({ email, password: PASSWORD }).expect(202);
    expect(await query('SELECT 1 FROM users WHERE email = $1', [email])).toHaveLength(1);
    expect(
      await query(
        "SELECT 1 FROM user_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1 AND t.purpose = 'VERIFY_EMAIL'",
        [email],
      ),
    ).toHaveLength(1);
  } finally {
    await down.close();
  }
});

it('con Redis caído el login funciona', async () => {
  const offline = await startTestApp(stack, {
    REDIS_URL: `redis://127.0.0.1:${await freePort()}`,
    REDIS_TIMEOUT: '200ms',
  });
  try {
    const { accessToken } = await registerAndLogin(offline.http);
    expect(accessToken).toBeTruthy();
  } finally {
    await offline.close();
  }
});

it('el correo no se escribe en los logs ni aparece el token del enlace', async () => {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
    }),
  );
  try {
    const local = `secreto-${Date.now()}`;
    const email = `${local}@example.test`;
    await register(email).expect(202);
    const link = await mailLink(testApp.smtp, email, 1);
    await login(email, 'no es la contraseña').expect(401);
    await login(email).expect(200);
    await send('/password-reset/request', { email }).expect(202);
    const reset = await mailLink(testApp.smtp, email, 2);
    await send('/email-verification', { token: link.token }).expect(204);
    await send('/password-reset', {
      token: reset.token,
      newPassword: 'la contraseña nueva',
    }).expect(204);
    await testApp.app.get(AuthMailer).whenIdle();

    const all = lines.join('\n');
    expect(lines.some((l) => l.startsWith('auth.registered user='))).toBe(true);
    expect(lines.some((l) => l.startsWith('auth.login user='))).toBe(true);
    expect(all).not.toContain(local);
    expect(all).not.toContain(link.token);
    expect(all).not.toContain(reset.token);
    expect(all).not.toContain(PASSWORD);
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
});

it('cuenta einvoice_auth_logins_total por resultado en METRICS_REGISTRY', async () => {
  const registry = testApp.app.get<Registry>(METRICS_REGISTRY);
  const count = async (result: string) => {
    const metric = await registry.getSingleMetric('einvoice_auth_logins_total')!.get();
    return metric.values.find((v) => v.labels['result'] === result)!.value;
  };
  const before = {
    success: await count('success'),
    failure: await count('failure'),
    locked: await count('locked'),
  };
  const email = newEmail();
  await register(email).expect(202);
  await login(email).expect(200);
  await login(email, 'no es').expect(401);
  // Fallos 2 y 3 dan 401; el 4.º es el quinto del correo y lo bloquea; el 5.º ya llega bloqueado.
  await login(email, 'no es').expect(401);
  await login(email, 'no es').expect(401);
  await login(email, 'no es').expect(401);
  await login(email, 'no es').expect(429);
  await login(email).expect(429);
  expect(await count('success')).toBe(before.success + 1);
  expect(await count('failure')).toBe(before.failure + 5);
  expect(await count('locked')).toBe(before.locked + 2);
});

it('un correo gigante no ASCII se rechaza con 400 y no con 500', async () => {
  const res = await http()
    .post('/api/v1/auth/register')
    .send({ email: `a@${'ñ'.repeat(200_000)}.c`, password: PASSWORD })
    .expect(400);
  expect(res.body.errorCode).toBe('VALIDATION_FAILED');
});

it('los textos de los campos no pueden ser objetos ni faltar', async () => {
  await http()
    .post('/api/v1/auth/login')
    .send({ email: { a: 1 }, password: PASSWORD })
    .expect(400);
  const missing = await http().post('/api/v1/auth/refresh').send({}).expect(400);
  expect(missing.body.errorCode).toBe('VALIDATION_FAILED');
});
