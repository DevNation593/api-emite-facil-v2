import { createHash, generateKeyPairSync } from 'node:crypto';
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import { inspectPkcs12, type SigningMaterial } from '../../../src/certificate/pkcs12-inspector.js';
import { buildInvoiceXml } from '../../../src/xml/invoice-xml.js';
import { DS, parseSigned } from '../../../src/signature/xades-profile.js';
import { SignatureInputError, SigningError, XadesBesSigner } from '../../../src/signature/xades-signer.js';
import { XmlRejectedError } from '../../../src/xml/secure-sax.js';
import { TEST_P12_PASSWORD, testP12 } from '../../support/test-certificates.js';
import { invoiceData, standardLines } from '../xml/invoice-fixtures.js';

// Traducción de signature/XadesSignatureIT.java (ficha técnica v2.34, sección 6 y Anexo 14). La verificación
// de la firma llega con XadesVerifier (Task 3); aquí se comprueba la estructura y que firma.
const ETSI = 'http://uri.etsi.org/01903/v1.3.2#';
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
const SIGNING_TIME = new Date('2026-10-07T21:57:32Z');

let material: SigningMaterial;
beforeAll(async () => {
  material = await inspectPkcs12(testP12('valid'), TEST_P12_PASSWORD, new Date());
});

const signer = new XadesBesSigner();
const unsigned = () => buildInvoiceXml(invoiceData());
const signed = () => signer.sign(unsigned(), material, SIGNING_TIME);

function only(document: Document, namespace: string, localName: string): Element {
  const nodes = document.getElementsByTagNameNS(namespace, localName);
  expect(nodes.length, localName).toBe(1);
  return nodes.item(0)!;
}

function inputError(action: () => unknown): SignatureInputError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SignatureInputError);
    return error as SignatureInputError;
  }
  throw new Error('No lanzó SignatureInputError');
}

it('signatureHasTheStructureOfAnnex14', () => {
  const document = parseSigned(signed());
  const root = document.documentElement!;
  const signature = only(document, DS, 'Signature');
  expect(signature.parentNode).toBe(root);
  expect(root.lastChild).toBe(signature);
  expect(signature.prefix).toBe('ds');
  const signatureId = signature.getAttribute('Id')!;
  expect(signatureId).not.toBe('');

  expect(only(document, DS, 'CanonicalizationMethod').getAttribute('Algorithm')).toBe(
    'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  );
  expect(only(document, DS, 'SignatureMethod').getAttribute('Algorithm')).toBe(
    'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  );
  expect(only(document, DS, 'SignedInfo').getAttribute('Id')).not.toBe('');
  expect(only(document, DS, 'SignatureValue').getAttribute('Id')).not.toBe('');

  const keyInfo = only(document, DS, 'KeyInfo');
  const signedProperties = only(document, ETSI, 'SignedProperties');
  expect(signedProperties.prefix).toBe('etsi');
  const references = only(document, DS, 'SignedInfo').getElementsByTagNameNS(DS, 'Reference');
  expect(references.length).toBe(3);

  const toProperties = references.item(0)!;
  expect(toProperties.getAttribute('Type')).toBe('http://uri.etsi.org/01903#SignedProperties');
  expect(toProperties.getAttribute('URI')).toBe(`#${signedProperties.getAttribute('Id')}`);
  expect(toProperties.getAttribute('Id')).not.toBe('');
  const toKeyInfo = references.item(1)!;
  expect(toKeyInfo.getAttribute('URI')).toBe(`#${keyInfo.getAttribute('Id')}`);
  const toDocument = references.item(2)!;
  expect(toDocument.getAttribute('URI')).toBe('#comprobante');
  const transforms = toDocument.getElementsByTagNameNS(DS, 'Transform');
  expect(transforms.length).toBe(1);
  expect(transforms.item(0)!.getAttribute('Algorithm')).toBe('http://www.w3.org/2000/09/xmldsig#enveloped-signature');
  expect(toProperties.getElementsByTagNameNS(DS, 'Transform').length).toBe(0);
  expect(toKeyInfo.getElementsByTagNameNS(DS, 'Transform').length).toBe(0);
  const digestMethods = document.getElementsByTagNameNS(DS, 'DigestMethod');
  expect(digestMethods.length).toBe(4);
  for (const method of Array.from(digestMethods)) expect(method.getAttribute('Algorithm')).toBe(SHA1);

  const certificateBase64 = only(document, DS, 'X509Certificate').textContent!.replace(/\s/g, '');
  expect(Buffer.from(certificateBase64, 'base64').equals(material.certificateDer)).toBe(true);
  expect(keyInfo.getElementsByTagNameNS(DS, 'RSAKeyValue').length).toBe(1);
  expect(only(document, DS, 'Modulus').textContent).not.toBe('');
  expect(only(document, DS, 'Exponent').textContent).toBe('AQAB');

  const qualifying = only(document, ETSI, 'QualifyingProperties');
  expect(qualifying.getAttribute('Target')).toBe(`#${signatureId}`);
  expect((qualifying.parentNode as Element).localName).toBe('Object');
  expect(only(document, ETSI, 'SigningTime').textContent).toBe('2026-10-07T16:57:32-05:00');
  const certDigest = only(document, ETSI, 'CertDigest').getElementsByTagNameNS(DS, 'DigestValue').item(0)!;
  expect(certDigest.textContent).toBe(createHash('sha1').update(material.certificateDer).digest('base64'));
  expect(only(document, DS, 'X509IssuerName').textContent).toBe(material.certificate.issuer);
  expect(only(document, DS, 'X509SerialNumber').textContent).toBe(material.certificate.serialNumber);
  const format = only(document, ETSI, 'DataObjectFormat');
  expect(format.getAttribute('ObjectReference')).toBe(`#${toDocument.getAttribute('Id')}`);
  expect(only(document, ETSI, 'Description').textContent).toBe('contenido comprobante');
  expect(only(document, ETSI, 'MimeType').textContent).toBe('text/xml');
});

it('signingDoesNotChangeTheInvoiceContent', () => {
  const xml = signed();
  const signedDocument = parseSigned(xml);
  const signature = only(signedDocument, DS, 'Signature');
  signature.parentNode!.removeChild(signature);
  signedDocument.normalize();
  expect(signedDocument.documentElement!.isEqualNode(parseSigned(unsigned()).documentElement!)).toBe(true);
  expect(xml.toString('utf8').startsWith('<?xml version="1.0" encoding="UTF-8"')).toBe(true);
});

it('specialCharactersSurviveSigning', () => {
  const name = "Ñandú & Hijos <\"S.A.\"> 'O'Brien' ✅ 😀";
  const xml = signer.sign(buildInvoiceXml(invoiceData({ issuerLegalName: name })), material, SIGNING_TIME);
  expect(parseSigned(xml).getElementsByTagName('razonSocial').item(0)!.textContent).toBe(name);
});

it('refusesToSignTwice', () => {
  const xml = signed();
  expect(inputError(() => signer.sign(xml, material, SIGNING_TIME)).message).toBe('El comprobante ya está firmado');
});

it('refusesDocumentWithoutComprobanteId', () => {
  const withoutId = Buffer.from(unsigned().toString('utf8').replace(' id="comprobante"', ''), 'utf8');
  expect(inputError(() => signer.sign(withoutId, material, SIGNING_TIME)).message).toBe(
    'La raíz del comprobante debe tener id="comprobante"',
  );
  expect(inputError(() => signer.sign(Buffer.from('<factura'), material, SIGNING_TIME)).message).toBe(
    'El comprobante no es un XML legible',
  );
});

it('largeInvoiceSignsAndVerifies (aquí solo que firma)', () => {
  const line = standardLines()[0]!;
  const xml = signer.sign(
    buildInvoiceXml(invoiceData({ lines: Array.from({ length: 500 }, () => line) })),
    material,
    SIGNING_TIME,
  );
  const document = parseSigned(xml);
  expect(document.getElementsByTagName('detalle').length).toBe(500);
  expect(document.documentElement!.lastChild).toBe(only(document, DS, 'Signature'));
});

it('un comprobante con DOCTYPE se rechaza antes de construir el DOM', () => {
  const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
  try {
    const withDoctype = Buffer.from(
      unsigned().toString('utf8').replace('?><factura', '?><!DOCTYPE factura [<!ENTITY x "y">]><factura'),
      'utf8',
    );
    const error = inputError(() => signer.sign(withDoctype, material, SIGNING_TIME));
    expect(error.message).toBe('El comprobante no es un XML legible');
    expect(error.cause).toBeInstanceOf(XmlRejectedError);
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

it('parseSigned propaga el rechazo de readXml', () => {
  expect(() => parseSigned(Buffer.from('<!DOCTYPE a><a/>'))).toThrow(XmlRejectedError);
});

it('pide los ocho números en el orden de XadesBesSigner', () => {
  let n = 0;
  const xml = new XadesBesSigner(() => ++n).sign(unsigned(), material, SIGNING_TIME).toString('utf8');
  expect(n).toBe(8);
  for (const id of [
    'Signature1',
    'Signature1-SignedProperties2',
    'Certificate3',
    'Reference-ID-4',
    'SignedPropertiesID5',
    'Signature-SignedInfo6',
    'Signature1-Object7',
    'SignatureValue8',
  ]) {
    expect(xml).toContain(` Id="${id}"`);
  }
  expect(xml).toContain(' URI="#Signature1-SignedProperties2"');
  expect(xml).toContain(' ObjectReference="#Reference-ID-4"');
});

it('por omisión los números son de seis cifras', () => {
  const ids = [...signed().toString('utf8').matchAll(/ Id="([^"]+)"/g)].map((m) => m[1]!);
  expect(ids).toHaveLength(8);
  for (const id of ids) {
    for (const number of id.match(/\d+/g)!) expect(number).toMatch(/^[1-9]\d{5}$/);
  }
});

it('SigningTime es la hora de Guayaquil truncada a segundos', () => {
  const xml = signer.sign(unsigned(), material, new Date('2026-01-01T04:59:59.999Z')).toString('utf8');
  expect(xml).toContain('<etsi:SigningTime>2025-12-31T23:59:59-05:00</etsi:SigningTime>');
});

it('una clave que no es RSA da SigningError sin datos de la clave', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  let caught: unknown;
  try {
    signer.sign(unsigned(), { ...material, privateKey }, SIGNING_TIME);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SigningError);
  expect((caught as Error).message).toBe('No se pudo firmar el comprobante');
});
