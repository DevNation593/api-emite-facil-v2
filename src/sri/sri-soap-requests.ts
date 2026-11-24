/*
 * Peticiones SOAP 1.1 a los servicios off-line del SRI, según sus WSDL (cotejados el 2026-10-11):
 * document/literal, elementos hijos sin espacio de nombres y soapAction vacío. Byte a byte como
 * sri/SriSoapRequests.java.
 */

export const RECEPTION_NS = 'http://ec.gob.sri.ws.recepcion';
export const AUTHORIZATION_NS = 'http://ec.gob.sri.ws.autorizacion';

const ACCESS_KEY = /^[0-9]{49}$/;

const OPEN =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="';

/** La clave no tiene 49 dígitos ASCII (el IllegalArgumentException de Java). */
export class InvalidAccessKeyError extends Error {
  constructor() {
    super('La clave de acceso debe tener 49 dígitos');
    this.name = 'InvalidAccessKeyError';
  }
}

/** validarComprobante: el XML firmado viaja en Base64 (xs:base64Binary). */
export function receptionRequest(signedXml: Buffer): Buffer {
  return Buffer.from(
    `${OPEN}${RECEPTION_NS}"><soapenv:Body><ec:validarComprobante><xml>${signedXml.toString('base64')}` +
      '</xml></ec:validarComprobante></soapenv:Body></soapenv:Envelope>',
    'utf8',
  );
}

/** autorizacionComprobante por clave de acceso. */
export function authorizationRequest(accessKey: string | null): Buffer {
  if (accessKey === null || !ACCESS_KEY.test(accessKey)) throw new InvalidAccessKeyError();
  return Buffer.from(
    `${OPEN}${AUTHORIZATION_NS}"><soapenv:Body><ec:autorizacionComprobante><claveAccesoComprobante>${accessKey}` +
      '</claveAccesoComprobante></ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>',
    'utf8',
  );
}
