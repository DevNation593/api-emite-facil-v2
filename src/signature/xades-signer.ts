import { createHash, randomInt, sign as rsaSign } from 'node:crypto';
import type { Document, Element } from '@xmldom/xmldom';
import { DateTime } from 'luxon';
import { C14nCanonicalization } from 'xml-crypto';
import type { SigningMaterial } from '../certificate/pkcs12-inspector.js';
import { FISCAL_ZONE } from '../sequence/fiscal-clock.js';
import { serializeLikeJdk } from './jdk-serializer.js';
import {
  C14N,
  DOCUMENT_ID,
  DS,
  ENVELOPED,
  parseSigned,
  RSA_SHA1,
  SHA1,
  SIGNED_PROPERTIES_TYPE,
  XADES,
} from './xades-profile.js';

/*
 * Firma XAdES-BES con la estructura del Anexo 14 de la ficha técnica del SRI, como
 * signature/XadesBesSigner.java: la firma cubre el comprobante, el elemento SignedProperties y el
 * KeyInfo que lleva el certificado. El XML firmado sale byte a byte como el de Java: mismos elementos,
 * mismo orden, misma C14N inclusiva y la serialización del Transformer del JDK (jdk-serializer.ts).
 */

/** El comprobante no se puede firmar tal como llega (el IllegalArgumentException de Java). */
export class SignatureInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SignatureInputError';
  }
}

/** Falló la firma en sí (el IllegalStateException de Java). El mensaje no lleva datos de la clave. */
export class SigningError extends Error {
  constructor(options?: ErrorOptions) {
    super('No se pudo firmar el comprobante', options);
    this.name = 'SigningError';
  }
}

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

interface NamespacePrefix {
  prefix: string;
  namespaceURI: string;
}

/** Las declaraciones de espacio de nombres en vigor sobre `node`, de sus ancestros (la más cercana manda). */
function ancestorNamespaces(node: Element): NamespacePrefix[] {
  const found = new Map<string, string>();
  for (let parent = node.parentNode; parent !== null && parent.nodeType === 1; parent = parent.parentNode) {
    for (const attr of Array.from((parent as Element).attributes)) {
      if (attr.namespaceURI !== XMLNS_NS) continue;
      const prefix = attr.nodeName === 'xmlns' ? '' : attr.localName!;
      if (!found.has(prefix)) found.set(prefix, attr.value);
    }
  }
  return [...found]
    .filter(([prefix, uri]) => prefix !== '' || uri !== '')
    .map(([prefix, namespaceURI]) => ({ prefix, namespaceURI }));
}

/** C14N inclusiva (sin comentarios) del subárbol de `node`, con los espacios de nombres que tiene en el documento. */
function canonicalize(node: Element): string {
  const c14n = new C14nCanonicalization();
  // xml-crypto tipa el nodo con el DOM del navegador; recorre el de xmldom igual.
  const target = node as unknown as Parameters<C14nCanonicalization['process']>[0];
  return c14n.process(target, { ancestorNamespaces: ancestorNamespaces(node) }) as string;
}

const base64 = (bytes: Buffer) => bytes.toString('base64');
const sha1 = (text: string) => base64(createHash('sha1').update(text, 'utf8').digest());

export class XadesBesSigner {
  constructor(private readonly nextNumber: () => number = () => randomInt(100_000, 1_000_000)) {}

  /**
   * Devuelve el XML con la firma añadida como último hijo del elemento raíz.
   * @throws SignatureInputError si el XML no se puede leer, su raíz no tiene id="comprobante" o ya está firmado
   * @throws SigningError si falla la firma
   */
  sign(unsignedXml: Buffer, material: SigningMaterial, signingTime: Date): Buffer {
    let document: Document;
    try {
      document = parseSigned(unsignedXml);
    } catch (error) {
      throw new SignatureInputError('El comprobante no es un XML legible', { cause: error });
    }
    const root = document.documentElement!;
    if (root.getAttribute('id') !== DOCUMENT_ID) {
      throw new SignatureInputError('La raíz del comprobante debe tener id="comprobante"');
    }
    if (document.getElementsByTagNameNS(DS, 'Signature').length > 0) {
      throw new SignatureInputError('El comprobante ya está firmado');
    }
    try {
      this.signInto(document, root, material, signingTime);
      return serializeLikeJdk(document);
    } catch (error) {
      throw new SigningError({ cause: error });
    }
  }

  private signInto(document: Document, root: Element, material: SigningMaterial, signingTime: Date): void {
    // SHA1withRSA de Java no admite otra clave: el SignatureMethod es rsa-sha1.
    if (material.privateKey.asymmetricKeyType !== 'rsa') throw new Error('La clave de firma no es RSA');
    const ds = (name: string) => document.createElementNS(DS, `ds:${name}`);
    const etsi = (name: string) => document.createElementNS(XADES, `etsi:${name}`);
    const child = (parent: Element, element: Element): Element => {
      parent.appendChild(element);
      return element;
    };
    const text = (element: Element, value: string): Element => {
      element.appendChild(document.createTextNode(value));
      return element;
    };
    const withAttributes = (element: Element, attributes: Record<string, string>): Element => {
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      return element;
    };

    const signatureId = `Signature${this.nextNumber()}`;
    const signedPropertiesId = `${signatureId}-SignedProperties${this.nextNumber()}`;
    const keyInfoId = `Certificate${this.nextNumber()}`;
    const documentReferenceId = `Reference-ID-${this.nextNumber()}`;

    // etsi:QualifyingProperties con las propiedades firmadas que pide XAdES-BES; la declaración va en
    // el propio elemento, como en Java.
    const qualifying = etsi('QualifyingProperties');
    qualifying.setAttributeNS(XMLNS_NS, 'xmlns:etsi', XADES);
    qualifying.setAttribute('Target', `#${signatureId}`);
    const signedProperties = withAttributes(child(qualifying, etsi('SignedProperties')), { Id: signedPropertiesId });
    const signatureProperties = child(signedProperties, etsi('SignedSignatureProperties'));
    text(
      child(signatureProperties, etsi('SigningTime')),
      DateTime.fromJSDate(signingTime, { zone: FISCAL_ZONE }).toFormat("yyyy-MM-dd'T'HH:mm:ssZZ"),
    );
    const cert = child(child(signatureProperties, etsi('SigningCertificate')), etsi('Cert'));
    const certDigest = child(cert, etsi('CertDigest'));
    withAttributes(child(certDigest, ds('DigestMethod')), { Algorithm: SHA1 });
    text(child(certDigest, ds('DigestValue')), base64(createHash('sha1').update(material.certificateDer).digest()));
    const issuerSerial = child(cert, etsi('IssuerSerial'));
    text(child(issuerSerial, ds('X509IssuerName')), material.certificate.issuer);
    text(child(issuerSerial, ds('X509SerialNumber')), material.certificate.serialNumber);
    const dataObjectFormat = withAttributes(
      child(child(signedProperties, etsi('SignedDataObjectProperties')), etsi('DataObjectFormat')),
      { ObjectReference: `#${documentReferenceId}` },
    );
    text(child(dataObjectFormat, etsi('Description')), 'contenido comprobante');
    text(child(dataObjectFormat, etsi('MimeType')), 'text/xml');

    // Los Id se piden en el orden en que Java construye las piezas de XMLDSig.
    const signedPropertiesReferenceId = `SignedPropertiesID${this.nextNumber()}`;
    const signedInfoId = `Signature-SignedInfo${this.nextNumber()}`;
    const objectId = `${signatureId}-Object${this.nextNumber()}`;
    const signatureValueId = `SignatureValue${this.nextNumber()}`;

    const signature = withAttributes(ds('Signature'), { Id: signatureId });
    signature.setAttributeNS(XMLNS_NS, 'xmlns:ds', DS);
    const signedInfo = withAttributes(child(signature, ds('SignedInfo')), { Id: signedInfoId });
    withAttributes(child(signedInfo, ds('CanonicalizationMethod')), { Algorithm: C14N });
    withAttributes(child(signedInfo, ds('SignatureMethod')), { Algorithm: RSA_SHA1 });
    const reference = (attributes: Record<string, string>, enveloped: boolean): Element => {
      const element = withAttributes(child(signedInfo, ds('Reference')), attributes);
      if (enveloped) withAttributes(child(child(element, ds('Transforms')), ds('Transform')), { Algorithm: ENVELOPED });
      withAttributes(child(element, ds('DigestMethod')), { Algorithm: SHA1 });
      return child(element, ds('DigestValue'));
    };
    const toSignedProperties = reference(
      { Id: signedPropertiesReferenceId, Type: SIGNED_PROPERTIES_TYPE, URI: `#${signedPropertiesId}` },
      false,
    );
    const toKeyInfo = reference({ URI: `#${keyInfoId}` }, false);
    const toDocument = reference({ Id: documentReferenceId, URI: `#${DOCUMENT_ID}` }, true);
    const signatureValue = withAttributes(child(signature, ds('SignatureValue')), { Id: signatureValueId });

    const keyInfo = withAttributes(child(signature, ds('KeyInfo')), { Id: keyInfoId });
    text(child(child(keyInfo, ds('X509Data')), ds('X509Certificate')), base64(material.certificateDer));
    // Modulus y Exponent en Base64 de la magnitud sin el byte de signo (CryptoBinary): la del JWK.
    const jwk = material.certificate.publicKey.export({ format: 'jwk' });
    const rsa = child(child(keyInfo, ds('KeyValue')), ds('RSAKeyValue'));
    text(child(rsa, ds('Modulus')), base64(Buffer.from(jwk.n!, 'base64url')));
    text(child(rsa, ds('Exponent')), base64(Buffer.from(jwk.e!, 'base64url')));

    child(withAttributes(child(signature, ds('Object')), { Id: objectId }), qualifying);

    // La transformación enveloped quita la firma: el comprobante se canonicaliza antes de añadirla.
    const documentDigest = sha1(canonicalize(root));
    root.appendChild(signature);
    text(toSignedProperties, sha1(canonicalize(signedProperties)));
    text(toKeyInfo, sha1(canonicalize(keyInfo)));
    text(toDocument, documentDigest);
    const value = rsaSign('sha1', Buffer.from(canonicalize(signedInfo), 'utf8'), material.privateKey);
    text(signatureValue, base64(value));
  }
}

