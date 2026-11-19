import { inspectPkcs12, type SigningMaterial } from '../../../src/certificate/pkcs12-inspector.js';
import { XadesVerifier } from '../../../src/signature/xades-verifier.js';
import { XadesBesSigner } from '../../../src/signature/xades-signer.js';
import { buildInvoiceXml, INVOICE_SCHEMA } from '../../../src/xml/invoice-xml.js';
import { XsdValidator } from '../../../src/xml/xsd-validator.js';
import { TEST_P12_PASSWORD, testP12 } from '../../support/test-certificates.js';
import { invoiceData, standardLines } from '../xml/invoice-fixtures.js';

// Traducción de la parte de verificación de signature/XadesSignatureIT.java.
const SIGNING_TIME = new Date('2026-10-07T21:57:32Z');

let material: SigningMaterial;
let other: SigningMaterial;
beforeAll(async () => {
  material = await inspectPkcs12(testP12('valid'), TEST_P12_PASSWORD, new Date());
  other = await inspectPkcs12(testP12('anotherValid'), TEST_P12_PASSWORD, new Date());
});

const signer = new XadesBesSigner();
const verifier = new XadesVerifier();
const unsigned = () => buildInvoiceXml(invoiceData());
const signed = () => signer.sign(unsigned(), material, SIGNING_TIME);
const text = (xml: Buffer) => xml.toString('utf8');
const bytes = (xml: string) => Buffer.from(xml, 'utf8');

it('signedInvoiceVerifies', () => {
  const verification = verifier.verify(signed());
  expect(verification.errors).toEqual([]);
  expect(verification.valid).toBe(true);
});

it('signedInvoiceIsStillValidAgainstXsd', async () => {
  expect((await new XsdValidator().validate(signed(), INVOICE_SCHEMA)).errors).toEqual([]);
});

it('tamperedAmountFailsVerification', () => {
  const tampered = text(signed()).replace('<importeTotal>37.00</importeTotal>', '<importeTotal>3.70</importeTotal>');
  expect(tampered).toContain('<importeTotal>3.70</importeTotal>');
  expect(verifier.verify(bytes(tampered)).valid).toBe(false);
});

it('tamperedSignedPropertiesFailsVerification', () => {
  const tampered = text(signed()).replace('2026-10-07T16:57:32-05:00', '2026-10-08T16:57:32-05:00');
  expect(tampered).toContain('2026-10-08T16:57:32-05:00');
  expect(verifier.verify(bytes(tampered)).valid).toBe(false);
});

it('swappedCertificateFailsVerification', () => {
  const xml = text(signed());
  const original = /<ds:X509Certificate>([^<]*)</.exec(xml)![1]!;
  const otherBase64 = other.certificateDer.toString('base64').replace(/.{76}(?=.)/g, '$&\n');
  const tampered = xml.replace(original, otherBase64);
  expect(tampered).not.toBe(xml);
  expect(verifier.verify(bytes(tampered)).valid).toBe(false);
});

it('signatureByAnotherKeyFailsVerification', () => {
  const mismatched: SigningMaterial = { ...material, privateKey: other.privateKey };
  expect(verifier.verify(signer.sign(unsigned(), mismatched, SIGNING_TIME)).valid).toBe(false);
});

it('specialCharactersSurviveSigning (verifica)', () => {
  const name = "Ñandú & Hijos <\"S.A.\"> 'O'Brien' ✅ 😀";
  const xml = signer.sign(buildInvoiceXml(invoiceData({ issuerLegalName: name })), material, SIGNING_TIME);
  expect(verifier.verify(xml).errors).toEqual([]);
});

it('unsignedOrUnreadableDocumentDoesNotVerify', () => {
  const result = verifier.verify(unsigned());
  expect(result.valid).toBe(false);
  expect(result.errors).not.toEqual([]);
  expect(verifier.verify(bytes('<factura')).valid).toBe(false);
});

it('signatureMovedOutOfTheRootDoesNotVerify', () => {
  const xml = text(signed());
  const start = xml.indexOf('<ds:Signature');
  const end = xml.indexOf('</ds:Signature>') + '</ds:Signature>'.length;
  const signature = xml.slice(start, end);
  const moved = xml.slice(0, start).replace('</infoFactura>', `${signature}</infoFactura>`) + xml.slice(end);
  expect(verifier.verify(bytes(moved)).valid).toBe(false);
});

it('largeInvoiceSignsAndVerifies', () => {
  const line = standardLines()[0]!;
  const xml = signer.sign(
    buildInvoiceXml(invoiceData({ lines: Array.from({ length: 500 }, () => line) })),
    material,
    SIGNING_TIME,
  );
  expect(verifier.verify(xml).valid).toBe(true);
});

it('nunca lanza: un error inesperado da "La firma no se pudo evaluar"', () => {
  const xml = text(signed()).replace(/<ds:X509Certificate>[^<]*</, '<ds:X509Certificate>AAAA<');
  expect(verifier.verify(bytes(xml))).toEqual({
    valid: false,
    errors: ['La firma no se pudo evaluar: CertificateException'],
  });
});

it('un DOCTYPE no se lee', () => {
  const xml = text(signed()).replace('?><factura', '?><!DOCTYPE factura [<!ENTITY e "x">]><factura');
  expect(verifier.verify(bytes(xml))).toEqual({ valid: false, errors: ['El comprobante no es un XML legible'] });
});
