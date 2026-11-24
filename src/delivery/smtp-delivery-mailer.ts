import MailComposer from 'nodemailer/lib/mail-composer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import type { AppConfig } from '../config/app-config.js';
import { smtpOptions, type SmtpTimeouts } from '../common/smtp-options.js';
import { validAddress } from './delivery-config.js';
import type { DeliveryEmail } from './delivery-email.js';
import type { DeliveryMailer, MailResult } from './delivery-mailer.js';

/*
 * Envío por SMTP con el servidor configurado en SPRING_MAIL_*, como delivery/SmtpDeliveryMailer.java. Un rechazo
 * del servidor con código 5xx es definitivo; todo lo demás (4xx, conexión caída, tiempo de espera) es temporal y se
 * puede reintentar. Se usa la conexión SMTP de nodemailer en vez de su transporte para saber en qué punto falló:
 * solo cuentan como rechazo las respuestas a MAIL FROM, RCPT TO y DATA.
 */

const MAX_ERROR = 300;

/** Lo que nodemailer añade a sus errores. */
interface SmtpError extends Error {
  code?: string;
  syscall?: string;
  command?: string;
  responseCode?: number;
  response?: string;
}

const failed = (permanent: boolean, error: string): MailResult => ({ sent: false, permanent, error });

/** Antes de empezar a enviar: la conexión, el saludo, TLS y las credenciales. Nada de esto es un rechazo. */
function connectionFailure(error: SmtpError): MailResult {
  return failed(false, `Sin respuesta del servidor de correo: ${causeName(error)}`);
}

/**
 * El nombre de la excepción raíz que Java anotaría, para que `lastError` diga lo mismo. Solo el tipo del fallo: el
 * mensaje puede llevar el servidor y el puerto.
 */
function causeName(error: SmtpError): string {
  switch (error.code) {
    case 'EDNS':
      return 'UnknownHostException';
    case 'ETIMEDOUT':
      return 'SocketTimeoutException';
    case 'EAUTH':
      return 'AuthenticationFailedException';
    case 'ETLS':
      // Con respuesta del servidor, no aceptó STARTTLS; sin ella, falló la negociación.
      return error.response === undefined ? 'SSLHandshakeException' : 'MessagingException';
    default:
      return error.syscall === 'connect' ? 'ConnectException' : 'MessagingException';
  }
}

/** Un fallo ya con la conversación en marcha: con respuesta del servidor, manda su código. */
function sendFailure(error: SmtpError): MailResult {
  const rejected = error.code === 'EENVELOPE' || error.code === 'EMESSAGE';
  if (rejected && error.responseCode !== undefined) {
    const text = `SMTP ${error.responseCode}: ${firstLine(error.response)}`;
    return failed(error.responseCode >= 500, text.slice(0, MAX_ERROR));
  }
  if (rejected) return failed(true, 'Dirección de correo no válida');
  // El servidor cerró la conexión sin responder: JavaMail lo anota como una respuesta -1.
  if (error.code === 'ECONNECTION') return failed(false, 'SMTP -1: [EOF]');
  return failed(false, 'Sin respuesta del servidor de correo: MailSendException');
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n', 1)[0]!.trim();
}

export class SmtpDeliveryMailer implements DeliveryMailer {
  private readonly options: ReturnType<typeof smtpOptions>;
  private readonly auth: { user: string; pass: string } | null;

  constructor(mail: AppConfig['mail'], timeouts?: SmtpTimeouts) {
    const { host } = mail;
    if (host === null) {
      throw new Error(
        'El envío de correo está habilitado (einvoice.delivery.email.enabled)' +
          ' pero no hay servidor SMTP configurado: falta spring.mail.host',
      );
    }
    this.options = smtpOptions({ ...mail, host }, timeouts);
    this.auth = mail.user === null ? null : { user: mail.user, pass: mail.password ?? '' };
  }

  async send(email: DeliveryEmail): Promise<MailResult> {
    if (!validAddress(email.to)) return failed(true, 'Dirección de correo no válida');
    const message = new MailComposer({
      from: { name: email.fromName, address: email.from },
      // Como objeto, nunca como texto: un texto se interpreta como lista de direcciones.
      to: { name: '', address: email.to },
      subject: email.subject,
      text: email.text,
      attachments: email.attachments,
      disableFileAccess: true,
      disableUrlAccess: true,
    }).compile();
    const messageId = message.messageId();
    const raw = await message.build();
    const connection = new SMTPConnection(this.options);
    try {
      return await this.converse(connection, email, raw, messageId);
    } finally {
      connection.close();
    }
  }

  private converse(
    connection: SMTPConnection,
    email: DeliveryEmail,
    raw: Buffer,
    messageId: string,
  ): Promise<MailResult> {
    return new Promise((resolve) => {
      let sending = false;
      const fail = (error: Error) =>
        resolve(sending ? sendFailure(error as SmtpError) : connectionFailure(error as SmtpError));
      // Los fallos de la conexión llegan por el evento o por la llamada en curso: vale el primero.
      connection.on('error', fail);
      connection.on('end', () => fail(Object.assign(new Error('Conexión cerrada'), { code: 'ECONNECTION' })));
      const send = () => {
        sending = true;
        connection.send({ from: email.from, to: [email.to] }, raw, (error) => {
          if (error) {
            fail(error);
            return;
          }
          resolve({ sent: true, messageId });
          connection.quit();
        });
      };
      connection.connect((error) => {
        if (error) {
          fail(error);
          return;
        }
        if (this.auth === null || !connection.allowsAuth) {
          send();
          return;
        }
        connection.login({ credentials: this.auth } as Parameters<SMTPConnection['login']>[0], (denied) => {
          if (denied) fail(denied);
          else send();
        });
      });
    });
  }
}
