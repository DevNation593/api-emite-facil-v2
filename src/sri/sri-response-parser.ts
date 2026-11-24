import { readXml } from '../xml/secure-sax.js';
import { javaTrim } from './sri-environment.js';
import { epochNanos, formatOffsetDateTime, parseOffsetDateTime, type OffsetDateTime } from './offset-date-time.js';
import type { AuthorizationResult, ReceptionResult, SriMessage } from './sri-results.js';

/*
 * Lee las respuestas SOAP de recepción y autorización del SRI (ficha técnica v2.34, numeral 7.2.3), como
 * sri/SriResponseParser.java. Nunca lanza: lo que no se entiende es un resultado FAILED con su explicación,
 * no un estado inventado. Los elementos se buscan por nombre local: el WSDL los declara por referencia, pero
 * el SRI los devuelve sin espacio de nombres. El XML pasa por `readXml`, que rechaza DOCTYPE y entidades.
 */

const MAX_MESSAGES = 100;
const MAX_TEXT = 2000;
const MAX_STATUS = 60;
const AUTHORIZATION_NUMBER = /^[0-9]{10,49}$/;
/** Hora de Ecuador continental, para las fechas que llegan sin desplazamiento. */
const ECUADOR_OFFSET_SECONDS = -5 * 3600;

/** Un elemento leído: su nombre local y sus hijos (elementos y texto, CDATA incluido). */
interface XmlElement {
  local: string;
  children: Array<XmlElement | string>;
}

class UnreadableResponse extends Error {}

function readTree(body: Buffer): XmlElement {
  const root: XmlElement = { local: '', children: [] };
  const stack: XmlElement[] = [root];
  readXml(body, {
    open(_uri, local) {
      const element: XmlElement = { local, children: [] };
      stack.at(-1)!.children.push(element);
      stack.push(element);
    },
    text(text) {
      stack.at(-1)!.children.push(text);
    },
    close() {
      stack.pop();
    },
  });
  return root;
}

/** Los descendientes con ese nombre local, en orden de documento (como getElementsByTagNameNS("*", …)). */
function descendants(element: XmlElement, local: string, into: XmlElement[] = []): XmlElement[] {
  for (const child of element.children) {
    if (typeof child === 'string') continue;
    if (child.local === local) into.push(child);
    descendants(child, local, into);
  }
  return into;
}

function textContent(element: XmlElement): string {
  return element.children.map((child) => (typeof child === 'string' ? child : textContent(child))).join('');
}

function children(parent: XmlElement, local: string): XmlElement[] {
  return parent.children.filter((child): child is XmlElement => typeof child !== 'string' && child.local === local);
}

function child(parent: XmlElement, local: string): XmlElement | null {
  return children(parent, local)[0] ?? null;
}

/** Texto del hijo, sin espacios alrededor; nulo si no existe o está vacío. */
function text(parent: XmlElement, local: string): string | null {
  const element = child(parent, local);
  if (element === null) return null;
  const value = javaTrim(textContent(element));
  return value === '' ? null : value;
}

/**
 * Recorta a `max` unidades UTF-16, como `substring` de Java. Si el corte parte un carácter fuera del BMP, la
 * mitad que queda se escribe como `?`: es lo que sale de Java al codificarla en UTF-8 (en la base, en el JSON).
 */
function bounded(value: string | null, max: number): string | null {
  if (value === null || value.length <= max) return value;
  const cut = value.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? `${cut.slice(0, -1)}?` : cut;
}

/** Como `String.equalsIgnoreCase` de Java, carácter a carácter (sin las expansiones de `toUpperCase`). */
function equalsIgnoreCase(value: string | null, expected: string): boolean {
  if (value === null || value.length !== expected.length) return false;
  for (let i = 0; i < value.length; i++) {
    const a = value[i]!;
    const b = expected[i]!;
    if (a === b) continue;
    const upperA = a.toUpperCase();
    if (upperA.length === 1 && upperA === b.toUpperCase()) continue;
    const lowerA = a.toLowerCase();
    if (lowerA.length === 1 && lowerA === b.toLowerCase()) continue;
    return false;
  }
  return true;
}

function responseElement(body: Buffer | null, local: string): XmlElement {
  if (body === null || body.length === 0) throw new UnreadableResponse('La respuesta del SRI llegó vacía');
  let document: XmlElement;
  try {
    document = readTree(body);
  } catch {
    throw new UnreadableResponse('La respuesta del SRI no es un XML legible');
  }
  if (descendants(document, 'Fault').length > 0) {
    throw new UnreadableResponse('El SRI respondió con un error SOAP (Fault)');
  }
  const found = descendants(document, local);
  if (found.length !== 1) throw new UnreadableResponse(`La respuesta del SRI no contiene ${local}`);
  return found[0]!;
}

function unreadableDetail(error: unknown): string {
  return error instanceof UnreadableResponse ? error.message : 'La respuesta del SRI no es un XML legible';
}

function addMessages(parent: XmlElement, into: SriMessage[]): void {
  const list = child(parent, 'mensajes');
  if (list === null) return;
  for (const message of children(list, 'mensaje')) {
    if (into.length === MAX_MESSAGES) return;
    into.push({
      identifier: bounded(text(message, 'identificador'), 20),
      message: bounded(text(message, 'mensaje'), MAX_TEXT),
      additionalInfo: bounded(text(message, 'informacionAdicional'), MAX_TEXT),
      type: bounded(text(message, 'tipo'), 30),
    });
  }
}

function date(value: string | null): OffsetDateTime | null {
  return value === null ? null : parseOffsetDateTime(value, ECUADOR_OFFSET_SECONDS);
}

const formatted = (value: OffsetDateTime | null) => (value === null ? null : formatOffsetDateTime(value));

export function parseReception(body: Buffer): ReceptionResult {
  let response: XmlElement;
  try {
    response = responseElement(body, 'RespuestaRecepcionComprobante');
  } catch (error) {
    return {
      outcome: 'FAILED',
      sriStatus: null,
      messages: [],
      httpStatus: null,
      errorDetail: unreadableDetail(error),
      rawResponse: null,
    };
  }
  const status = text(response, 'estado');
  const messages: SriMessage[] = [];
  const vouchers = child(response, 'comprobantes');
  if (vouchers !== null) {
    for (const voucher of children(vouchers, 'comprobante')) addMessages(voucher, messages);
  }
  let outcome: ReceptionResult['outcome'];
  let errorDetail: string | null = null;
  if (equalsIgnoreCase(status, 'RECIBIDA')) {
    outcome = 'RECEIVED';
  } else if (equalsIgnoreCase(status, 'DEVUELTA')) {
    outcome = 'RETURNED';
  } else {
    outcome = 'FAILED';
    errorDetail = status === null ? 'La respuesta de recepción no trae estado' : 'Estado de recepción desconocido';
  }
  return {
    outcome,
    sriStatus: bounded(status, MAX_STATUS),
    messages,
    httpStatus: null,
    errorDetail,
    rawResponse: null,
  };
}

function authorizationOf(
  fields: Partial<AuthorizationResult> & Pick<AuthorizationResult, 'outcome'>,
): AuthorizationResult {
  return {
    sriStatus: null,
    consultedAccessKey: null,
    authorizationNumber: null,
    authorizedAt: null,
    environmentLabel: null,
    messages: [],
    httpStatus: null,
    errorDetail: null,
    rawResponse: null,
    ...fields,
  };
}

function authorized(entry: XmlElement, consulted: string | null): AuthorizationResult {
  const status = bounded(text(entry, 'estado'), MAX_STATUS);
  const number = text(entry, 'numeroAutorizacion');
  const authorizedAt = date(text(entry, 'fechaAutorizacion'));
  const messages: SriMessage[] = [];
  addMessages(entry, messages);
  let error: string | null = null;
  if (number === null || !AUTHORIZATION_NUMBER.test(number)) {
    error = 'La autorización no trae un número de autorización válido';
  } else if (authorizedAt === null) {
    error = 'La autorización no trae una fecha legible';
  }
  const environmentLabel = text(entry, 'ambiente');
  if (error !== null) {
    return authorizationOf({
      outcome: 'FAILED',
      sriStatus: status,
      consultedAccessKey: consulted,
      environmentLabel,
      messages,
      errorDetail: error,
    });
  }
  return authorizationOf({
    outcome: 'AUTHORIZED',
    sriStatus: status,
    consultedAccessKey: consulted,
    authorizationNumber: number,
    authorizedAt: formatted(authorizedAt),
    environmentLabel,
    messages,
  });
}

export function parseAuthorization(body: Buffer): AuthorizationResult {
  let response: XmlElement;
  try {
    response = responseElement(body, 'RespuestaAutorizacionComprobante');
  } catch (error) {
    return authorizationOf({ outcome: 'FAILED', errorDetail: unreadableDetail(error) });
  }
  const consulted = text(response, 'claveAccesoConsultada');
  const list = child(response, 'autorizaciones');
  const entries = list === null ? [] : children(list, 'autorizacion');
  if (entries.length === 0) return authorizationOf({ outcome: 'NOT_FOUND', consultedAccessKey: consulted });
  // Puede haber varias respuestas no autorizadas y una sola autorizada: esa manda.
  for (const entry of entries) {
    if (equalsIgnoreCase(text(entry, 'estado'), 'AUTORIZADO')) return authorized(entry, consulted);
  }
  let latest = entries[0]!;
  let latestDate = date(text(latest, 'fechaAutorizacion'));
  for (const entry of entries) {
    const entryDate = date(text(entry, 'fechaAutorizacion'));
    if (entryDate !== null && (latestDate === null || epochNanos(entryDate) > epochNanos(latestDate))) {
      latest = entry;
      latestDate = entryDate;
    }
  }
  const status = text(latest, 'estado');
  const normalized = (status ?? '').toUpperCase();
  const rejected = normalized === 'NO AUTORIZADO' || normalized === 'RECHAZADO';
  const messages: SriMessage[] = [];
  addMessages(latest, messages);
  return authorizationOf({
    outcome: rejected ? 'NOT_AUTHORIZED' : 'PROCESSING',
    sriStatus: bounded(status, MAX_STATUS),
    consultedAccessKey: consulted,
    authorizedAt: formatted(latestDate),
    environmentLabel: text(latest, 'ambiente'),
    messages,
  });
}
