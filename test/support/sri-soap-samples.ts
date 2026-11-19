/*
 * Respuestas SOAP del SRI con la forma de los ejemplos del numeral 7.2.3 de la ficha técnica v2.34,
 * parametrizadas por clave de acceso. Port de support/SriSoapSamples.java: las usan las pruebas del lector
 * de respuestas y el SRI simulado.
 */

export const AUTHORIZATION_DATE = '2012-03-05T16:57:34.997-05:00';

export interface Msg {
  identifier: string;
  text: string;
  additionalInfo: string | null;
  type: string;
}

export const msg = (identifier: string, text: string, additionalInfo: string | null, type: string): Msg => ({
  identifier,
  text,
  additionalInfo,
  type,
});

export const errorMsg = (identifier: string, text: string): Msg => msg(identifier, text, null, 'ERROR');

function messageXml(m: Msg): string {
  return (
    `<mensaje><identificador>${m.identifier}</identificador><mensaje>${m.text}</mensaje>` +
    (m.additionalInfo === null ? '' : `<informacionAdicional>${m.additionalInfo}</informacionAdicional>`) +
    `<tipo>${m.type}</tipo></mensaje>`
  );
}

function envelope(body: string): string {
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
}

function reception(content: string): string {
  return envelope(
    '<ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion">' +
      `<RespuestaRecepcionComprobante>${content}</RespuestaRecepcionComprobante>` +
      '</ns2:validarComprobanteResponse>',
  );
}

export function received(): string {
  return reception('<estado>RECIBIDA</estado><comprobantes/>');
}

export function returned(accessKey: string, ...messages: Msg[]): string {
  return reception(
    `<estado>DEVUELTA</estado><comprobantes><comprobante><claveAcceso>${accessKey}` +
      `</claveAcceso><mensajes>${messages.map(messageXml).join('')}</mensajes></comprobante></comprobantes>`,
  );
}

/** Respuesta de recepción con un estado cualquiera, para los casos que el contrato no prevé. */
export function receptionWithState(state: string): string {
  return reception(`<estado>${state}</estado><comprobantes/>`);
}

/** Un elemento autorizacion. Los datos nulos se omiten. */
export function autorizacion(
  state: string,
  number: string | null,
  date: string | null,
  environment: string | null,
  ...messages: Msg[]
): string {
  return (
    `<autorizacion><estado>${state}</estado>` +
    (number === null ? '' : `<numeroAutorizacion> ${number} </numeroAutorizacion>`) +
    (date === null ? '' : `<fechaAutorizacion>${date}</fechaAutorizacion>`) +
    (environment === null ? '' : `<ambiente>${environment}</ambiente>`) +
    '<comprobante><![CDATA[<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante"' +
    ` version="1.1.0"></factura>]]></comprobante><mensajes>${messages.map(messageXml).join('')}</mensajes></autorizacion>`
  );
}

export function authorizations(consultedAccessKey: string, ...items: string[]): string {
  return envelope(
    '<ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion">' +
      `<RespuestaAutorizacionComprobante><claveAccesoConsultada> ${consultedAccessKey}` +
      ` </claveAccesoConsultada><numeroComprobantes>${items.length}</numeroComprobantes>` +
      (items.length === 0 ? '<autorizaciones/>' : `<autorizaciones>${items.join('')}</autorizaciones>`) +
      '</RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse>',
  );
}

/** Comprobante autorizado en el ambiente de pruebas, con la advertencia 60 que el SRI añade en él. */
export function authorized(accessKey: string): string {
  return authorizedIn(accessKey, 'PRUEBAS');
}

export function authorizedIn(accessKey: string, environment: string): string {
  return authorizations(
    accessKey,
    autorizacion(
      'AUTORIZADO',
      accessKey,
      AUTHORIZATION_DATE,
      environment,
      msg('60', 'ESTE PROCESO FUE REALIZADO EN EL AMBIENTE DE PRUEBAS', null, 'ADVERTENCIA'),
    ),
  );
}

export function notAuthorized(accessKey: string, state: string, ...messages: Msg[]): string {
  return authorizations(accessKey, autorizacion(state, null, '2012-02-13T16:34:48.997-05:00', 'PRUEBAS', ...messages));
}

export function processing(accessKey: string): string {
  return authorizations(accessKey, autorizacion('EN PROCESO', null, null, 'PRUEBAS'));
}

export function notFound(accessKey: string): string {
  return authorizations(accessKey);
}

/** Respuesta de autorización vacía: ni clave consultada ni autorizaciones. */
export function emptyAuthorizationResponse(): string {
  return envelope(
    '<ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion">' +
      '<RespuestaAutorizacionComprobante/></ns2:autorizacionComprobanteResponse>',
  );
}

export function fault(): string {
  return envelope('<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Error interno</faultstring></soap:Fault>');
}
