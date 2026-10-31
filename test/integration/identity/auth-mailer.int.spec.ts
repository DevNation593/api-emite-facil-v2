import net from 'node:net';
import { testEnv } from '../../support/test-env.js';
import { loadConfig } from '../../../src/config/app-config.js';
import {
  AuthMailer,
  verificationMail,
} from '../../../src/identity/auth-mailer.js';
import { startSmtpStub, type SmtpStub } from '../../support/smtp-stub.js';

const SECRET_LINK = 'http://localhost:3000/verify#token=SECRETO-123';

function mailConfig(port: number, from: string | null = 'facturas@example.ec') {
  return loadConfig({
    ...testEnv,
    SPRING_MAIL_HOST: '127.0.0.1',
    SPRING_MAIL_PORT: String(port),
    SMTP_STARTTLS: 'false',
    ...(from ? { DELIVERY_EMAIL_FROM: from } : {}),
  }).mail;
}

function recorder() {
  const lines: string[] = [];
  return {
    lines,
    log: (m: string) => lines.push(`log ${m}`),
    warn: (m: string) => lines.push(`warn ${m}`),
  };
}

let stub: SmtpStub;
beforeAll(async () => {
  stub = await startSmtpStub();
});
afterAll(async () => {
  await stub.stop();
});

it('entrega el correo con el remitente y el texto exactos', async () => {
  const logs = recorder();
  const mailer = new AuthMailer(mailConfig(stub.port), logs);
  const mail = verificationMail('cliente@example.ec', SECRET_LINK, 86_400_000);
  mailer.send(mail);
  await mailer.whenIdle();

  const [message] = stub.messages();
  expect(message).toBeDefined();
  expect(message?.from).toContain('facturas@example.ec');
  expect(message?.from).toContain('Facturación electrónica');
  expect(message?.to).toContain('cliente@example.ec');
  expect(message?.subject).toBe('Confirma tu correo');
  expect(message?.text.replace(/\r\n/g, '\n')).toBe(mail.text);
  expect(logs.lines).toEqual(['log Correo de cuenta enviado: VERIFY_EMAIL']);
  mailer.close();
});

it('con el servidor caído send no lanza y el log no lleva el enlace', async () => {
  const free = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
  const logs = recorder();
  const mailer = new AuthMailer(mailConfig(free), logs);
  expect(() =>
    mailer.send(verificationMail('x@example.ec', SECRET_LINK, 3_600_000)),
  ).not.toThrow();
  await mailer.whenIdle();

  expect(logs.lines).toHaveLength(1);
  expect(logs.lines[0]).toMatch(
    /^warn No se pudo enviar el correo de cuenta \(VERIFY_EMAIL\)/,
  );
  expect(logs.lines.join('\n')).not.toContain('SECRETO');
  expect(logs.lines.join('\n')).not.toContain('token=');
  mailer.close();
});

it('sin remitente avisa al arrancar y por correo, sin el enlace', async () => {
  const logs = recorder();
  const mailer = new AuthMailer(mailConfig(stub.port, null), logs);
  mailer.send(verificationMail('x@example.ec', SECRET_LINK, 3_600_000));
  await mailer.whenIdle();
  expect(logs.lines).toHaveLength(2);
  expect(logs.lines.every((l) => l.startsWith('warn '))).toBe(true);
  expect(logs.lines.join('\n')).not.toContain('SECRETO');
  expect(stub.messages()).toHaveLength(1); // solo el de la primera prueba
  mailer.close();
});
