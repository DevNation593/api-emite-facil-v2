import { buildAuthorizedXml } from '../../../src/delivery/authorized-xml.js';
import { parseSigned } from '../../../src/signature/xades-profile.js';

// Traducción de delivery/AuthorizedXmlBuilderTest.java.
const KEY = '1210202601179001234500110010010000000011234567813';
const AUTHORIZED_AT = '2026-10-12T14:30:00.000000';
const SIGNED =
  '<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="1.1.0"><infoTributaria>' +
  `<razonSocial>Ñandú &amp; Cía. S.A.</razonSocial><claveAcceso>${KEY}</claveAcceso></infoTributaria>` +
  '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignatureValue>AbC+/=</ds:SignatureValue>' +
  '</ds:Signature></factura>';

const text = (xml: Buffer, name: string) => parseSigned(xml).getElementsByTagName(name).item(0)!.textContent;
const build = (signed: string, environment: 'TEST' | 'PRODUCTION' = 'TEST') =>
  buildAuthorizedXml(KEY, AUTHORIZED_AT, environment, Buffer.from(signed, 'utf8'));

it('wrapsTheSignedInvoiceUntouched', () => {
  const xml = build(SIGNED);

  expect(xml.toString('utf8')).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  expect(parseSigned(xml).documentElement!.tagName).toBe('autorizacion');
  expect(text(xml, 'estado')).toBe('AUTORIZADO');
  expect(text(xml, 'numeroAutorizacion')).toBe(KEY);
  expect(text(xml, 'fechaAutorizacion')).toBe('2026-10-12T09:30:00-05:00');
  expect(text(xml, 'ambiente')).toBe('PRUEBAS');
  expect(text(xml, 'comprobante')).toBe(SIGNED);
  expect(parseSigned(xml).getElementsByTagName('mensajes').length).toBe(1);
});

it('productionLabel', () => {
  expect(text(build(SIGNED, 'PRODUCTION'), 'ambiente')).toBe('PRODUCCIÓN');
});

it('cdataTerminatorInsideTheInvoiceIsPreserved', () => {
  const tricky =
    '<?xml version="1.0" encoding="UTF-8"?><factura><descripcion>a ]]&gt; b ]]> c</descripcion></factura>';

  expect(text(build(tricky), 'comprobante')).toBe(tricky);
});

it('rejectsMissingData', () => {
  const signed = Buffer.from(SIGNED, 'utf8');

  expect(() => buildAuthorizedXml(null, AUTHORIZED_AT, 'TEST', signed)).toThrow('Falta el número de autorización');
  expect(() => buildAuthorizedXml(' ', AUTHORIZED_AT, 'TEST', signed)).toThrow('Falta el número de autorización');
  expect(() => buildAuthorizedXml('12<3', AUTHORIZED_AT, 'TEST', signed)).toThrow('Falta el número de autorización');
  expect(() => buildAuthorizedXml(KEY, null, 'TEST', signed)).toThrow('Falta la fecha de autorización');
  expect(() => buildAuthorizedXml(KEY, AUTHORIZED_AT, 'TEST', Buffer.alloc(0))).toThrow('Falta el comprobante firmado');
});
