import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApp } from '../../src/bootstrap.js';
import type { StackHandle } from './containers.js';
import { startSmtpStub, type SmtpStub } from './smtp-stub.js';

/** La contraseña de las cuentas de prueba (12 caracteres o más). */
export const PASSWORD = 'una contraseña larga';

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  smtp: SmtpStub;
  close(): Promise<void>;
}

/**
 * Crea la aplicación contra los contenedores del stack y un SMTP en memoria. AppModule lee la
 * configuración de `process.env` al crearse, así que se fija el entorno solo mientras arranca y
 * después se restaura: lo ya leído no cambia y otras pruebas no heredan estos valores.
 */
export async function startTestApp(
  stack: Pick<StackHandle, 'databaseUrl' | 'rabbitUrl' | 'redisUrl'>,
  env: Record<string, string> = {},
): Promise<TestApp> {
  const smtp = await startSmtpStub();
  const values: Record<string, string> = {
    DATABASE_URL: stack.databaseUrl,
    RABBITMQ_URL: stack.rabbitUrl,
    REDIS_URL: stack.redisUrl,
    SPRING_MAIL_HOST: '127.0.0.1',
    SPRING_MAIL_PORT: String(smtp.port),
    SMTP_STARTTLS: 'false',
    DELIVERY_EMAIL_FROM: 'facturas@example.test',
    EINVOICE_WEB_URL: 'http://web.test',
    ...env,
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  let app: NestExpressApplication;
  try {
    app = await createApp();
    await app.init();
  } catch (error) {
    await smtp.stop();
    throw error;
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return {
    app,
    http: request(app.getHttpServer()),
    smtp,
    close: async () => {
      await app.close();
      await smtp.stop();
    },
  };
}

/** Una IP distinta por petición: el límite por IP de /auth es de 20 por minuto y las pruebas hacen más. */
export function freshIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 250);
  return `198.51.${octet()}.${octet()}`;
}

export function newEmail(): string {
  return `u-${randomUUID()}@example.test`;
}

/** El `sub` de un token de acceso, sin verificarlo: solo para que las pruebas conozcan al usuario. */
function subject(accessToken: string): string {
  const payload = accessToken.split('.')[1]!;
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub: string }).sub;
}

/** Registra una cuenta y entra con ella. */
export async function registerAndLogin(
  http: ReturnType<typeof request>,
  email: string = newEmail(),
): Promise<{ accessToken: string; refreshToken: string; userId: string; email: string }> {
  await http
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD })
    .expect(202);
  const res = await http
    .post('/api/v1/auth/login')
    .set('X-Forwarded-For', freshIp())
    .send({ email, password: PASSWORD })
    .expect(200);
  const body = res.body as { accessToken: string; refreshToken: string };
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: subject(body.accessToken),
    email,
  };
}

const LINK = /http:\/\/web\.test(\/[a-z-]+)#token=([A-Za-z0-9_-]+)/;

/** Espera el correo número n (desde 1) que llega a esa dirección y saca su enlace. */
export async function mailLink(
  smtp: SmtpStub,
  email: string,
  n = 1,
): Promise<{ path: string; token: string; subject: string }> {
  const mails = () => smtp.messages().filter((m) => m.to.includes(email));
  const deadline = Date.now() + 10_000;
  while (mails().length < n) {
    if (Date.now() > deadline) throw new Error(`no llegó el correo ${n} a ${email}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const message = mails()[n - 1]!;
  const match = LINK.exec(message.text.replace(/=\r?\n/g, ''));
  if (match === null) throw new Error('el correo no trae un enlace a la web');
  return { path: match[1]!, token: match[2]!, subject: message.subject };
}
