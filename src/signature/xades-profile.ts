import { DOMParser, type Document } from '@xmldom/xmldom';
import { readXml, XmlMalformedError } from '../xml/secure-sax.js';

/*
 * Parámetros de firma que fija la ficha técnica v2.34 del SRI (sección 6 y Anexo 14), como
 * signature/XadesProfile.java. SHA-1 es criptográficamente débil, pero es lo que el SRI exige: no se
 * cambia por decisión propia.
 */

export const DS = 'http://www.w3.org/2000/09/xmldsig#';

export const XADES = 'http://uri.etsi.org/01903/v1.3.2#';

export const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

export const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';

export const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';

export const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export const SIGNED_PROPERTIES_TYPE = 'http://uri.etsi.org/01903#SignedProperties';

/** Valor del atributo id de la raíz de todo comprobante, y destino de la referencia al documento. */
export const DOCUMENT_ID = 'comprobante';

/**
 * Lee un XML con espacios de nombres, sin DOCTYPE y sin acceso externo. Primero lo recorre `readXml`
 * (que rechaza DOCTYPE, entidades y XML mal formado, y cuyo error se propaga); el DOM de xmldom solo
 * recibe XML que ya pasó esa lectura.
 */
export function parseSigned(xml: Buffer): Document {
  readXml(xml, {});
  const text = new TextDecoder('utf-8', { fatal: true }).decode(xml);
  return new DOMParser({
    locator: false,
    // XML 1.0 (sección 2.11), como Xerces: solo \r\n y \r pasan a \n. La regla por omisión de xmldom es
    // la de XML 1.1 y convertiría también U+0085 y U+2028, que cambiarían el texto firmado.
    normalizeLineEndings: (source) => source.replace(/\r\n?/g, '\n'),
    onError: (level, message) => {
      // readXml ya aceptó el documento: un error aquí es una diferencia entre los dos lectores.
      if (level !== 'warning') throw new XmlMalformedError(message, 0);
    },
  }).parseFromString(text, 'text/xml');
}
