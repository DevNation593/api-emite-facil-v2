/*
 * Evento del outbox tal como viaja por RabbitMQ, como orchestration/DocumentEvent.java: solo identificadores.
 * Los ids salen en minúsculas (UUID.toString de Java): `signingMaterial` y el resto los comparan así.
 */

export interface DocumentEvent {
  eventId: string | null;
  tenantId: string;
  documentId: string;
  eventType: string | null;
}

/** El mensaje no se puede procesar: va a la cola de mensajes muertos sin volver a la cola. */
export class RejectedEvent extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RejectedEvent';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw new RejectedEvent('Evento ilegible');
  return value.toLowerCase();
}

/** Lee el mensaje; uno ilegible o incompleto lanza RejectedEvent. */
export function readDocumentEvent(body: Buffer): DocumentEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch (error) {
    throw new RejectedEvent('Evento ilegible', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RejectedEvent('Evento ilegible');
  }
  const fields = parsed as Record<string, unknown>;
  const eventType = fields.eventType;
  if (eventType !== undefined && eventType !== null && typeof eventType !== 'string') {
    throw new RejectedEvent('Evento ilegible');
  }
  const eventId = uuid(fields.eventId);
  const tenantId = uuid(fields.tenantId);
  const documentId = uuid(fields.documentId);
  if (tenantId === null || documentId === null) throw new RejectedEvent('Evento sin empresa o sin documento');
  return { eventId, tenantId, documentId, eventType: (eventType as string | null | undefined) ?? null };
}
