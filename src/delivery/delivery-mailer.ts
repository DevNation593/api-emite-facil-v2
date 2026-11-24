import type { DeliveryEmail } from './delivery-email.js';

/**
 * Resultado de un envío: `permanent` si el fallo es definitivo (reintentar no lo arreglará) y `error`, una
 * descripción breve sin el contenido del mensaje.
 */
export type MailResult = { sent: true; messageId: string } | { sent: false; permanent: boolean; error: string | null };

/** Envío de un correo de entrega. Nunca lanza: un fallo es un resultado. */
export interface DeliveryMailer {
  send(email: DeliveryEmail): Promise<MailResult>;
}
