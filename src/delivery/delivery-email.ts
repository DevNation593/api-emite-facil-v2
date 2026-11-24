import { documentNumber } from '../billing/document-envelope.js';
import type { RideEnvelope } from '../billing/ride-envelope.js';
import { isIsoControl, isJavaWhitespace, javaTrim } from '../common/java-text.js';
import { localDateText } from '../common/java-time.js';

/*
 * Redacta el correo de entrega de un comprobante autorizado, con el RIDE y el XML autorizado adjuntos (ficha
 * técnica, 4.7: el emisor debe enviar el comprobante al receptor por correo electrónico), como
 * delivery/DeliveryEmailFactory.java.
 */

export interface DeliveryAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** Correo con el que se entrega un comprobante: remitente, destinatario, texto y adjuntos. */
export interface DeliveryEmail {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  attachments: DeliveryAttachment[];
}

const MAX_NAME = 120;
const MAX_SUBJECT = 200;

export function buildDeliveryEmail(
  from: string,
  ride: RideEnvelope,
  displayName: string,
  fileStem: string,
  recipient: string,
  ridePdf: Buffer,
  authorizedXml: Buffer,
): DeliveryEmail {
  const document = ride.envelope;
  const number = documentNumber(document);
  const tradeName = headerSafe(document.issuer.tradeName, MAX_NAME);
  const issuer = tradeName === '' ? headerSafe(document.issuer.legalName, MAX_NAME) : tradeName;
  const subject = headerSafe(`${displayName} ${number} de ${issuer}`, MAX_SUBJECT);
  const total = document.totals === null ? '' : `Valor total: ${document.totals.total.toFixed(2)} USD\n`;
  const text =
    `Estimado(a) ${document.recipient.name}:\n\n${document.issuer.legalName}` +
    ` (RUC ${document.issuer.ruc}) le ha emitido la ${displayName.toLowerCase()}` +
    ` electrónica ${number}.\n\nFecha de emisión: ${localDateText(document.issueDate)}\n` +
    `${total}Clave de acceso: ${document.accessKey}\nNúmero de autorización: ` +
    `${ride.authorizationNumber}\n\n` +
    'Se adjuntan el RIDE (PDF) y el comprobante autorizado (XML). Puede verificar su validez en el' +
    ' portal del SRI con la clave de acceso.\n';
  return {
    from,
    fromName: issuer,
    to: recipient,
    subject,
    text,
    attachments: [
      { filename: `${fileStem}-${number}.pdf`, contentType: 'application/pdf', content: ridePdf },
      { filename: `${document.accessKey}.xml`, contentType: 'application/xml', content: authorizedXml },
    ],
  };
}

/**
 * Texto apto para una cabecera del correo: sin caracteres de control (un salto de línea permitiría añadir
 * cabeceras), con los espacios reducidos y de longitud acotada.
 */
export function headerSafe(value: string | null, max: number): string {
  if (value === null) return '';
  let out = '';
  for (const character of value) {
    if (isIsoControl(character) || isJavaWhitespace(character)) {
      if (out !== '' && !out.endsWith(' ')) out += ' ';
    } else {
      out += character;
    }
  }
  const clean = javaTrim(out);
  return clean.length <= max ? clean : javaTrim(clean.slice(0, max));
}
