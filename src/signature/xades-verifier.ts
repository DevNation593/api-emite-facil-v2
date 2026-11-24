import { createHash, type KeyObject, verify as rsaVerify } from 'node:crypto';
import type { Document, Element } from '@xmldom/xmldom';
import { certificateInfo, type CertificateInfo } from '../certificate/pkcs12-inspector.js';
import { canonicalize } from './xades-signer.js';
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
 * Comprueba que un comprobante firmado cumple el perfil de la ficha técnica y que su firma es
 * criptográficamente válida con el certificado que lleva dentro, como signature/XadesVerifier.java. Se usa
 * antes de dar un XML por firmado. No valida la cadena de confianza ni la revocación del certificado: eso lo
 * hace el SRI. Mismos mensajes y mismo orden de comprobaciones que Java.
 */

export interface SignatureVerification {
  valid: boolean;
  errors: string[];
}

/**
 * Un fallo que en Java es una excepción de la API de firma; `javaName` es el nombre simple de su clase, que
 * acaba en el mensaje "La firma no se pudo evaluar: <clase>".
 */
class EvaluationError extends Error {
  constructor(
    readonly javaName: 'CertificateException' | 'MarshalException' | 'XMLSignatureException',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = javaName;
  }
}

const marshal = (message: string) => new EvaluationError('MarshalException', message);

/** Como `Base64.getMimeDecoder()`: ignora lo que no es del alfabeto (saltos de línea incluidos). */
function mimeDecode(text: string | null): Buffer {
  return Buffer.from((text ?? '').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
}

/** El único descendiente con ese nombre, o nulo si no hay exactamente uno. */
function single(parent: Element, namespace: string, localName: string): Element | null {
  const nodes = parent.getElementsByTagNameNS(namespace, localName);
  return nodes.length === 1 ? nodes.item(0) : null;
}

function elementChildren(parent: Element): Element[] {
  return Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1);
}

const isDs = (element: Element | undefined, localName: string) =>
  element !== undefined && element.namespaceURI === DS && element.localName === localName;

/** El atributo Algorithm de un elemento de XMLDSig; sin él, Java no puede leer la firma. */
function algorithm(element: Element): string {
  const value = element.getAttribute('Algorithm');
  if (!value) throw marshal(`${element.localName} sin Algorithm`);
  return value;
}

interface Reference {
  uri: string | null;
  type: string | null;
  transforms: string[];
  digestAlgorithm: string;
  digestValue: Buffer;
}

interface SignedInfo {
  element: Element;
  canonicalization: string;
  signatureMethod: string;
  references: Reference[];
}

interface ParsedSignature {
  signedInfo: SignedInfo;
  signatureValue: Buffer;
}

/** Lo que lee `unmarshalXMLSignature` de Java: la estructura fija de XMLDSig, o MarshalException. */
function unmarshal(signature: Element): ParsedSignature {
  const [signedInfoElement, signatureValueElement] = elementChildren(signature);
  if (!isDs(signedInfoElement, 'SignedInfo')) throw marshal('Falta SignedInfo');
  if (!isDs(signatureValueElement, 'SignatureValue')) throw marshal('Falta SignatureValue');
  const [canonicalization, signatureMethod, ...rest] = elementChildren(signedInfoElement!);
  if (!isDs(canonicalization, 'CanonicalizationMethod')) throw marshal('Falta CanonicalizationMethod');
  if (!isDs(signatureMethod, 'SignatureMethod')) throw marshal('Falta SignatureMethod');
  if (rest.length === 0) throw marshal('SignedInfo sin Reference');
  const references = rest.map((element): Reference => {
    if (!isDs(element, 'Reference')) throw marshal('Elemento inesperado en SignedInfo');
    const children = elementChildren(element);
    const transforms: string[] = [];
    if (isDs(children[0], 'Transforms')) {
      for (const transform of elementChildren(children.shift()!)) {
        if (!isDs(transform, 'Transform')) throw marshal('Elemento inesperado en Transforms');
        transforms.push(algorithm(transform));
      }
    }
    const [digestMethod, digestValue] = children;
    if (!isDs(digestMethod, 'DigestMethod')) throw marshal('Falta DigestMethod');
    if (!isDs(digestValue, 'DigestValue')) throw marshal('Falta DigestValue');
    return {
      uri: element.getAttributeNode('URI')?.value ?? null,
      type: element.getAttributeNode('Type')?.value ?? null,
      transforms,
      digestAlgorithm: algorithm(digestMethod!),
      digestValue: mimeDecode(digestValue!.textContent),
    };
  });
  return {
    signedInfo: {
      element: signedInfoElement!,
      canonicalization: algorithm(canonicalization!),
      signatureMethod: algorithm(signatureMethod!),
      references,
    },
    signatureValue: mimeDecode(signatureValueElement!.textContent),
  };
}

function readCertificate(element: Element): CertificateInfo & { der: Buffer } {
  const der = mimeDecode(element.textContent);
  try {
    return { ...certificateInfo(der), der };
  } catch (error) {
    throw new EvaluationError('CertificateException', 'Certificado ilegible', { cause: error });
  }
}

/** Exactamente las tres referencias del Anexo 14, con sus algoritmos y sin transformaciones de más. */
function checkProfile(signedInfo: SignedInfo, signedPropertiesId: string, keyInfoId: string, errors: string[]): void {
  if (signedInfo.canonicalization !== C14N || signedInfo.signatureMethod !== RSA_SHA1) {
    errors.push('La firma no usa los algoritmos del perfil del SRI');
  }
  let properties = false;
  let keyInfo = false;
  let document = false;
  for (const reference of signedInfo.references) {
    if (reference.digestAlgorithm !== SHA1) errors.push('Una referencia no usa el digest del perfil del SRI');
    if (
      reference.uri === `#${signedPropertiesId}` &&
      reference.type === SIGNED_PROPERTIES_TYPE &&
      reference.transforms.length === 0
    ) {
      properties = true;
    } else if (reference.uri === `#${keyInfoId}` && keyInfoId !== '' && reference.transforms.length === 0) {
      keyInfo = true;
    } else if (
      reference.uri === `#${DOCUMENT_ID}` &&
      reference.transforms.length === 1 &&
      reference.transforms[0] === ENVELOPED
    ) {
      document = true;
    } else {
      errors.push('La firma contiene una referencia que el perfil no admite');
    }
  }
  if (signedInfo.references.length !== 3 || !properties || !keyInfo || !document) {
    errors.push('La firma debe cubrir el comprobante, SignedProperties y KeyInfo');
  }
}

/** El certificado de KeyInfo debe ser el que declara SigningCertificate. */
function checkSigningCertificate(
  signedProperties: Element,
  certificate: CertificateInfo & { der: Buffer },
  errors: string[],
): void {
  const certDigest = single(signedProperties, XADES, 'CertDigest');
  const digestValue = certDigest === null ? null : single(certDigest, DS, 'DigestValue');
  const issuerName = single(signedProperties, DS, 'X509IssuerName');
  const serialNumber = single(signedProperties, DS, 'X509SerialNumber');
  if (digestValue === null || issuerName === null || serialNumber === null) {
    errors.push('SigningCertificate está incompleto');
    return;
  }
  const declared = mimeDecode(digestValue.textContent);
  const actual = createHash('sha1').update(certificate.der).digest();
  if (
    !declared.equals(actual) ||
    certificate.issuer !== (issuerName.textContent ?? '') ||
    certificate.serialNumber !== (serialNumber.textContent ?? '').trim()
  ) {
    errors.push('El certificado de KeyInfo no es el declarado en SigningCertificate');
  }
}

/** SHA1withRSA como el JDK: una firma que no mide lo que el módulo es un error, no un "no coincide". */
function signatureValueMatches(signedInfo: Element, value: Buffer, publicKey: KeyObject): boolean {
  if (publicKey.asymmetricKeyType !== 'rsa') {
    throw new EvaluationError('XMLSignatureException', 'La clave del certificado no es RSA');
  }
  const modulusBytes = Math.ceil((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) / 8);
  if (value.length !== modulusBytes) {
    throw new EvaluationError('XMLSignatureException', 'La firma no mide lo que la clave');
  }
  return rsaVerify('sha1', Buffer.from(canonicalize(signedInfo), 'utf8'), publicKey, value);
}

const sha1 = (text: string) => createHash('sha1').update(text, 'utf8').digest();

/** C14N del comprobante tras la transformación enveloped: sin la firma que contiene la referencia. */
function envelopedDigest(root: Element, signature: Element): Buffer {
  const next = signature.nextSibling;
  root.removeChild(signature);
  try {
    return sha1(canonicalize(root));
  } finally {
    root.insertBefore(signature, next);
  }
}

function check(document: Document, errors: string[]): void {
  const root = document.documentElement!;
  const signatures = document.getElementsByTagNameNS(DS, 'Signature');
  if (signatures.length !== 1 || signatures.item(0)!.parentNode !== root) {
    errors.push('Debe haber exactamente una firma, hija del elemento raíz');
    return;
  }
  const signatureElement = signatures.item(0)!;
  const signedProperties = single(signatureElement, XADES, 'SignedProperties');
  const keyInfoElement = single(signatureElement, DS, 'KeyInfo');
  const certificateElement = single(signatureElement, DS, 'X509Certificate');
  if (
    signedProperties === null ||
    keyInfoElement === null ||
    certificateElement === null ||
    root.getAttribute('id') !== DOCUMENT_ID
  ) {
    errors.push('La firma no tiene la estructura XAdES-BES esperada');
    return;
  }
  const certificate = readCertificate(certificateElement);
  const signature = unmarshal(signatureElement);

  const signedPropertiesId = signedProperties.getAttribute('Id') ?? '';
  const keyInfoId = keyInfoElement.getAttribute('Id') ?? '';
  checkProfile(signature.signedInfo, signedPropertiesId, keyInfoId, errors);
  checkSigningCertificate(signedProperties, certificate, errors);
  if (errors.length > 0) return;

  const valueMatches = signatureValueMatches(
    signature.signedInfo.element,
    signature.signatureValue,
    certificate.publicKey,
  );
  // El perfil ya fijó que cada referencia apunta a uno de estos tres nodos.
  const digests = new Map<string, () => Buffer>([
    [`#${signedPropertiesId}`, () => sha1(canonicalize(signedProperties))],
    [`#${keyInfoId}`, () => sha1(canonicalize(keyInfoElement))],
    [`#${DOCUMENT_ID}`, () => envelopedDigest(root, signatureElement)],
  ]);
  const altered = signature.signedInfo.references.filter(
    (reference) => !digests.get(reference.uri!)!().equals(reference.digestValue),
  );
  if (valueMatches && altered.length === 0) return;
  if (!valueMatches) errors.push('El valor de la firma no corresponde al certificado');
  for (const reference of altered) errors.push(`El contenido referido por ${reference.uri} fue alterado`);
}

export class XadesVerifier {
  /** Nunca lanza: todo problema llega como error de la verificación. */
  verify(signedXml: Buffer): SignatureVerification {
    const errors: string[] = [];
    let document: Document;
    try {
      document = parseSigned(signedXml);
    } catch {
      errors.push('El comprobante no es un XML legible');
      return { valid: false, errors };
    }
    try {
      check(document, errors);
    } catch (error) {
      const name = error instanceof EvaluationError ? error.javaName : 'RuntimeException';
      errors.push(`La firma no se pudo evaluar: ${name}`);
    }
    return { valid: errors.length === 0, errors };
  }
}
