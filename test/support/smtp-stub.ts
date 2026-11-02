import type { AddressInfo } from 'node:net';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';

export interface ReceivedMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface SmtpStub {
  port: number;
  messages(): ReceivedMessage[];
  stop(): Promise<void>;
}

/** Servidor SMTP en memoria, sin TLS ni autenticación: para probar qué correo sale. */
export async function startSmtpStub(): Promise<SmtpStub> {
  const received: ReceivedMessage[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    onData(stream, _session, callback) {
      simpleParser(stream)
        .then((parsed) => {
          received.push({
            from: parsed.from?.text ?? '',
            to: Array.isArray(parsed.to)
              ? parsed.to.map((a) => a.text).join(', ')
              : (parsed.to?.text ?? ''),
            subject: parsed.subject ?? '',
            text: parsed.text ?? '',
          });
          callback();
        })
        .catch((error: Error) => callback(error));
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.server.address() as AddressInfo;
  return {
    port,
    messages: () => [...received],
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
