import { readFileSync } from 'node:fs';
import { simpleParser } from 'mailparser';
import type { DeliveryEmail } from '../../../src/delivery/delivery-email.js';
import { SmtpDeliveryMailer } from '../../../src/delivery/smtp-delivery-mailer.js';
import { startCannedSmtp } from '../../support/scripted-smtp.js';

// Cómo clasifica SmtpDeliveryMailer de Java cada respuesta del servidor (familia delivery, parte `mailer`) y cómo
// sale el mensaje. Sin contenedores: usa sockets locales.
interface MailerCase {
  name: string;
  to: string;
  script: Record<string, string>;
  result: { sent: boolean; permanent: boolean; error: string | null; hasMessageId: boolean };
}
const golden = JSON.parse(readFileSync(new URL('../../golden/delivery.json', import.meta.url), 'utf8')) as {
  mailer: MailerCase[];
};

const TIMEOUTS = { connectionMs: 2_000, socketMs: 1_000 };

const email = (to = 'cliente@example.test', content = Buffer.from('pdf')): DeliveryEmail => ({
  from: 'facturas@plataforma.test',
  fromName: 'Andina Ñandú "S.A."',
  to,
  subject: 'Factura 001-001-000000001 de Ñandú',
  text: 'Estimado(a) María:\n\nAdjuntamos la factura.\n.\nFin\n',
  attachments: [
    { filename: 'factura-001-001-000000001.pdf', contentType: 'application/pdf', content },
    { filename: '123.xml', contentType: 'application/xml', content: Buffer.from('<a>ñ</a>', 'utf8') },
  ],
});

const mailer = (port: number, extra: Partial<ConstructorParameters<typeof SmtpDeliveryMailer>[0]> = {}) =>
  new SmtpDeliveryMailer(
    { host: '127.0.0.1', port, user: null, password: null, startTls: false, from: null, ...extra },
    TIMEOUTS,
  );

/**
 * Diferencias deliberadas con Java: 251 al final es un mensaje aceptado (Java lo daría por fallo y lo repetiría),
 * el texto del servidor se lee en UTF-8 (Java lo lee en Latin-1) y una lista o un grupo no se envía nunca (en Java
 * lo descarta antes DeliveryService).
 */
const ELSEWHERE = new Set(['fin 251', 'dirección en grupo']);
const asJava = (text: string | null) => (text === null ? null : Buffer.from(text, 'utf8').toString('latin1'));

describe('cada respuesta del servidor', () => {
  it.each(golden.mailer.filter((c) => !ELSEWHERE.has(c.name)))(
    '$name',
    async ({ to, script, result }) => {
      const server = await startCannedSmtp(script);
      try {
        if (script.OPTION === 'CLOSED') await server.close();
        const sender = mailer(server.port, {
          host: script.OPTION === 'UNKNOWN_HOST' ? 'no-existe.invalid' : '127.0.0.1',
          startTls: script.OPTION === 'STARTTLS',
          ...(script.OPTION === 'AUTH' ? { user: 'usuario', password: 'clave' } : {}),
        });

        const sent = await sender.send(email(to));

        if (result.sent) {
          expect(sent).toEqual({ sent: true, messageId: expect.stringMatching(/^<.+@.+>$/) });
        } else {
          expect(sent).toMatchObject({ sent: false, permanent: result.permanent });
          const { error } = sent as { error: string };
          expect([error, asJava(error)]).toContain(result.error);
        }
      } finally {
        await server.close();
      }
    },
    15_000,
  );

  it('251 al final es un mensaje aceptado', async () => {
    const server = await startCannedSmtp({ END: '251 se reenviará' });
    try {
      expect(await mailer(server.port).send(email())).toMatchObject({ sent: true });
    } finally {
      await server.close();
    }
  });

  it.each(['grupo:a@x.test,b@y.test;', 'a@x.test,b@y.test', 'a@x.test\r\nBcc: b@y.test'])(
    'a %j no se contacta al servidor',
    async (to) => {
      const server = await startCannedSmtp({});
      try {
        expect(await mailer(server.port).send(email(to))).toEqual({
          sent: false,
          permanent: true,
          error: 'Dirección de correo no válida',
        });
        expect(server.messages).toEqual([]);
      } finally {
        await server.close();
      }
    },
  );

  it('el error no nombra el servidor ni el puerto', async () => {
    const server = await startCannedSmtp({ GREETING: 'DROP' });
    await server.close();
    const result = (await mailer(server.port).send(email())) as { error: string };
    expect(result.error).not.toContain('127.0.0.1');
    expect(result.error).not.toContain(String(server.port));
  });
});

it('el mensaje lleva tres partes, un destinatario y los adjuntos byte a byte', async () => {
  const pdf = Buffer.from(Array.from({ length: 5_000 }, (_, i) => (i * 31) % 256));
  const server = await startCannedSmtp({});
  try {
    expect(await mailer(server.port).send(email('cliente@example.test', pdf))).toMatchObject({ sent: true });
    const raw = server.messages[0]!;
    const parsed = await simpleParser(raw);
    expect(parsed.from!.value).toEqual([{ address: 'facturas@plataforma.test', name: 'Andina Ñandú "S.A."' }]);
    expect(Array.isArray(parsed.to) ? [] : parsed.to!.value).toEqual([{ address: 'cliente@example.test', name: '' }]);
    expect(parsed.cc).toBeUndefined();
    expect(parsed.subject).toBe('Factura 001-001-000000001 de Ñandú');
    expect(parsed.text).toBe('Estimado(a) María:\n\nAdjuntamos la factura.\n.\nFin\n');
    expect(parsed.html).toBe(false);
    expect(parsed.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      ['factura-001-001-000000001.pdf', 'application/pdf'],
      ['123.xml', 'application/xml'],
    ]);
    expect(parsed.attachments[0]!.content.equals(pdf)).toBe(true);
    expect(parsed.attachments[1]!.content.toString('utf8')).toBe('<a>ñ</a>');
    const text = raw.toString('latin1');
    expect(text).toMatch(/^Content-Type: multipart\/mixed;/m);
    expect(text).toMatch(/^Content-Type: text\/plain; charset=utf-8/im);
    expect(text.match(/^Content-Disposition: attachment/gm)).toHaveLength(2);
    expect(parsed.messageId).toBeTruthy();
  } finally {
    await server.close();
  }
});

it('sin servidor configurado no se construye', () => {
  expect(() => mailer(25, { host: null })).toThrow(
    'El envío de correo está habilitado (einvoice.delivery.email.enabled) pero no hay servidor SMTP configurado: falta spring.mail.host',
  );
});
