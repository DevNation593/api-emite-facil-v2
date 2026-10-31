import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { AppConfig } from '../config/app-config.js';

/** Nombre visible del remitente; el del producto aún no está decidido. */
const PRODUCT = 'Facturación electrónica';

const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 30_000;
const SOCKET_TIMEOUT_MS = 30_000;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Lo que se pide enviar; `kind` es lo único que se registra en los logs. */
export interface AuthMail {
  to: string;
  subject: string;
  text: string;
  kind: string;
}

export interface MailLogger {
  log(message: string): void;
  warn(message: string): void;
}

/** Igual que `describe` de Java: horas enteras si caben, si no minutos. */
export function describeDuration(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours >= 1 && Math.floor(ms / MINUTE_MS) % 60 === 0) {
    return hours === 1 ? '1 hora' : `${hours} horas`;
  }
  const minutes = Math.floor(ms / MINUTE_MS);
  return minutes === 1 ? '1 minuto' : `${minutes} minutos`;
}

export function verificationMail(
  to: string,
  link: string,
  ttlMs: number,
): AuthMail {
  return {
    to,
    subject: 'Confirma tu correo',
    kind: 'VERIFY_EMAIL',
    text:
      'Hola:\n\n' +
      'Para confirmar que este correo es tuyo, abre este enlace:\n\n' +
      `${link}\n\n` +
      `El enlace vale ${describeDuration(ttlMs)}. Si no creaste una cuenta de facturación electrónica, ignora este mensaje.\n`,
  };
}

export function passwordResetMail(
  to: string,
  link: string,
  ttlMs: number,
): AuthMail {
  return {
    to,
    subject: 'Cambia tu contraseña',
    kind: 'RESET_PASSWORD',
    text:
      'Hola:\n\n' +
      'Alguien pidió cambiar la contraseña de tu cuenta. Para elegir una nueva, abre este enlace:\n\n' +
      `${link}\n\n` +
      `El enlace vale ${describeDuration(ttlMs)} y sirve una sola vez. Si no lo pediste tú, ignora este mensaje: tu contraseña\n` +
      'sigue siendo la misma.\n',
  };
}

/** Respuesta a un registro con un correo que ya tiene cuenta: la página no lo revela, el correo sí. */
export function alreadyRegisteredMail(
  to: string,
  resetLink: string,
  ttlMs: number,
): AuthMail {
  return {
    to,
    subject: 'Ya tienes una cuenta',
    kind: 'ALREADY_REGISTERED',
    text:
      'Hola:\n\n' +
      'Alguien intentó crear una cuenta con este correo, pero ya tienes una. Si fuiste tú y no\n' +
      `recuerdas tu contraseña, elige una nueva con este enlace (vale ${describeDuration(ttlMs)}):\n\n` +
      `${resetLink}\n\n` +
      'Si no fuiste tú, ignora este mensaje.\n',
  };
}

/**
 * Correos de la cuenta (confirmar el correo, cambiar la contraseña, avisar de cuenta existente).
 * `send` no espera ni lanza: el llamador lo invoca tras confirmar su transacción. Sin SMTP la
 * aplicación funciona pero estos correos no llegan: se avisa al arrancar y en cada intento, y
 * nunca se escribe el enlace ni el destinatario.
 */
export class AuthMailer {
  private readonly transport: Transporter | null;
  private readonly from: string | null;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    mail: AppConfig['mail'],
    private readonly logger: MailLogger = new Logger(AuthMailer.name),
  ) {
    this.from = mail.from?.trim() || null;
    if (mail.host === null || this.from === null) {
      this.transport = null;
      this.logger.warn(
        'Sin servidor SMTP (SPRING_MAIL_HOST) o sin remitente (DELIVERY_EMAIL_FROM): los correos para confirmar la cuenta y cambiar la contraseña no se enviarán',
      );
      return;
    }
    this.transport = createTransport({
      host: mail.host,
      port: mail.port,
      secure: false,
      // STARTTLS exigido salvo SMTP_STARTTLS=false.
      requireTLS: mail.startTls,
      ignoreTLS: !mail.startTls,
      auth:
        mail.user !== null
          ? { user: mail.user, pass: mail.password ?? '' }
          : undefined,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
  }

  send(mail: AuthMail): void {
    const transport = this.transport;
    const from = this.from;
    if (transport === null || from === null) {
      this.logger.warn(
        `Correo de cuenta (${mail.kind}) sin enviar: no hay servidor SMTP o remitente configurado`,
      );
      return;
    }
    const task: Promise<void> = transport
      .sendMail({
        from: { name: PRODUCT, address: from },
        // Como objeto, nunca como texto: un texto se interpreta como lista de direcciones.
        to: { address: mail.to },
        subject: mail.subject,
        text: mail.text,
      })
      .then(() => {
        this.logger.log(`Correo de cuenta enviado: ${mail.kind}`);
      })
      .catch(() => {
        // Se puede volver a pedir. Solo el tipo: el error podría citar el enlace o credenciales.
        this.logger.warn(
          `No se pudo enviar el correo de cuenta (${mail.kind})`,
        );
      })
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  /** Espera a los envíos en curso; solo para pruebas. */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  close(): void {
    this.transport?.close();
  }
}
