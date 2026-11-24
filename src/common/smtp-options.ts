import type { AppConfig } from '../config/app-config.js';

/** Plazos de la conexión y de cada respuesta del servidor (spring.mail.properties de application.yml). */
export interface SmtpTimeouts {
  connectionMs: number;
  socketMs: number;
}

const DEFAULT_TIMEOUTS: SmtpTimeouts = { connectionMs: 10_000, socketMs: 30_000 };

/** Cómo se conecta al servidor SMTP: lo comparten los correos de la cuenta y la entrega de comprobantes. */
export function smtpOptions(mail: AppConfig['mail'] & { host: string }, timeouts: SmtpTimeouts = DEFAULT_TIMEOUTS) {
  return {
    host: mail.host,
    port: mail.port,
    secure: false,
    // STARTTLS exigido salvo SMTP_STARTTLS=false.
    requireTLS: mail.startTls,
    ignoreTLS: !mail.startTls,
    connectionTimeout: timeouts.connectionMs,
    greetingTimeout: timeouts.socketMs,
    socketTimeout: timeouts.socketMs,
  };
}
