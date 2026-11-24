import { ecuadorOffsetDateTime } from '../common/java-time.js';
import type { SriEnvironment } from '../sri/sri-environment.js';

/*
 * XML autorizado que se entrega al receptor, como delivery/AuthorizedXmlBuilder.java: los datos de la autorización
 * del SRI y, dentro, el comprobante firmado tal cual se envió. El comprobante va en una sección CDATA para que sus
 * bytes —y con ellos su firma— no cambien.
 */

const AUTHORIZATION_NUMBER = /^[0-9]{10,49}$/;

const CDATA_END = Buffer.from(']]>', 'ascii');

/** Lo que reparte "]]>" entre dos secciones CDATA contiguas: no puede aparecer dentro de una. */
const CDATA_SPLIT = Buffer.from(']]]]><![CDATA[>', 'ascii');

function splitCdataEnds(content: Buffer): Buffer {
  const parts: Buffer[] = [];
  let from = 0;
  for (let at = content.indexOf(CDATA_END); at >= 0; at = content.indexOf(CDATA_END, from)) {
    parts.push(content.subarray(from, at), CDATA_SPLIT);
    from = at + CDATA_END.length;
  }
  parts.push(content.subarray(from));
  return Buffer.concat(parts);
}

/** `authorizedAt` es el instante en UTC (`YYYY-MM-DDTHH:MM:SS.ffffff`). */
export function buildAuthorizedXml(
  authorizationNumber: string | null,
  authorizedAt: string | null,
  environment: SriEnvironment,
  signedXml: Buffer | null,
): Buffer {
  if (authorizationNumber === null || !AUTHORIZATION_NUMBER.test(authorizationNumber)) {
    throw new Error('Falta el número de autorización');
  }
  if (authorizedAt === null) throw new Error('Falta la fecha de autorización');
  if (signedXml === null || signedXml.length === 0) throw new Error('Falta el comprobante firmado');
  const head =
    '<?xml version="1.0" encoding="UTF-8"?>\n<autorizacion>\n' +
    '<estado>AUTORIZADO</estado>\n' +
    `<numeroAutorizacion>${authorizationNumber}</numeroAutorizacion>\n` +
    `<fechaAutorizacion>${ecuadorOffsetDateTime(authorizedAt)}</fechaAutorizacion>\n` +
    `<ambiente>${environment === 'PRODUCTION' ? 'PRODUCCIÓN' : 'PRUEBAS'}</ambiente>\n` +
    '<comprobante><![CDATA[';
  return Buffer.concat([
    Buffer.from(head, 'utf8'),
    splitCdataEnds(signedXml),
    Buffer.from(']]></comprobante>\n<mensajes/>\n</autorizacion>\n', 'utf8'),
  ]);
}
