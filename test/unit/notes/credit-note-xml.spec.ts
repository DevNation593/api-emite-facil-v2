import { checkEnvelope } from '../../../src/xml/envelope-rules.js';
import { XsdValidator } from '../../../src/xml/xsd-validator.js';
import {
  buildCreditNoteXml,
  CREDIT_NOTE_SCHEMA,
} from '../../../src/notes/credit-note-content.js';
import type { DocumentEnvelope } from '../../../src/billing/document-envelope.js';
import type { CreditNoteContent } from '../../../src/notes/credit-note-content.js';
import { accessKeyOf, creditContent, creditEnvelope } from './note-fixtures.js';

// Traducción de CreditNoteXmlBuilderTest: formato de nota de crédito versión 1.1.0 (XSD NotaCredito_V1.1.0).
const validator = new XsdValidator();
const ACCESS_KEY_NOTE = accessKeyOf('04');
const xml = (envelope: DocumentEnvelope, content: CreditNoteContent) =>
  buildCreditNoteXml(envelope, content).toString('utf8');

async function expectValid(
  envelope: DocumentEnvelope,
  content: CreditNoteContent,
): Promise<void> {
  const bytes = buildCreditNoteXml(envelope, content);
  const result = await validator.validate(bytes, CREDIT_NOTE_SCHEMA);
  expect(result.errors).toEqual([]);
  expect([...checkEnvelope(bytes, CREDIT_NOTE_SCHEMA)]).toEqual([]);
}

const EXPECTED =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<notaCredito id="comprobante" version="1.1.0">' +
  '<infoTributaria><ambiente>1</ambiente><tipoEmision>1</tipoEmision>' +
  '<razonSocial>Comercial Andina S.A.</razonSocial><nombreComercial>Andina</nombreComercial>' +
  `<ruc>1790012345001</ruc><claveAcceso>${ACCESS_KEY_NOTE}</claveAcceso>` +
  '<codDoc>04</codDoc><estab>001</estab><ptoEmi>002</ptoEmi><secuencial>000000007</secuencial>' +
  '<dirMatriz>Av. Amazonas N34-12, Quito</dirMatriz></infoTributaria>' +
  '<infoNotaCredito><fechaEmision>19/10/2026</fechaEmision>' +
  '<dirEstablecimiento>Av. 10 de Agosto, Quito</dirEstablecimiento>' +
  '<tipoIdentificacionComprador>05</tipoIdentificacionComprador>' +
  '<razonSocialComprador>María Pérez</razonSocialComprador>' +
  '<identificacionComprador>1712345678</identificacionComprador>' +
  '<obligadoContabilidad>NO</obligadoContabilidad>' +
  '<codDocModificado>01</codDocModificado><numDocModificado>001-001-000000123</numDocModificado>' +
  '<fechaEmisionDocSustento>01/10/2026</fechaEmisionDocSustento>' +
  '<totalSinImpuestos>34.00</totalSinImpuestos><valorModificacion>37.00</valorModificacion>' +
  '<moneda>DOLAR</moneda><totalConImpuestos>' +
  '<totalImpuesto><codigo>2</codigo><codigoPorcentaje>0</codigoPorcentaje>' +
  '<baseImponible>14.00</baseImponible><valor>0.00</valor></totalImpuesto>' +
  '<totalImpuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje>' +
  '<baseImponible>20.00</baseImponible><valor>3.00</valor></totalImpuesto>' +
  '</totalConImpuestos><motivo>Devolución de mercadería</motivo></infoNotaCredito>' +
  '<detalles>' +
  '<detalle><codigoInterno>SRV-001</codigoInterno><descripcion>Servicio de consultoría</descripcion>' +
  '<cantidad>2.000000</cantidad><precioUnitario>10.000000</precioUnitario><descuento>0.00</descuento>' +
  '<precioTotalSinImpuesto>20.00</precioTotalSinImpuesto><impuestos><impuesto><codigo>2</codigo>' +
  '<codigoPorcentaje>4</codigoPorcentaje><tarifa>15.00</tarifa><baseImponible>20.00</baseImponible>' +
  '<valor>3.00</valor></impuesto></impuestos></detalle>' +
  '<detalle><codigoInterno>LIB-001</codigoInterno><descripcion>Libro</descripcion>' +
  '<cantidad>1.500000</cantidad><precioUnitario>9.333333</precioUnitario><descuento>0.00</descuento>' +
  '<precioTotalSinImpuesto>14.00</precioTotalSinImpuesto><impuestos><impuesto><codigo>2</codigo>' +
  '<codigoPorcentaje>0</codigoPorcentaje><tarifa>0.00</tarifa><baseImponible>14.00</baseImponible>' +
  '<valor>0.00</valor></impuesto></impuestos></detalle>' +
  '</detalles></notaCredito>';

it('produce el XML esperado', () => {
  expect(xml(creditEnvelope(), creditContent())).toBe(EXPECTED);
});

it('es válida contra el XSD y las reglas del sobre', async () => {
  await expectValid(creditEnvelope(), creditContent());
});

it('los mismos datos dan los mismos bytes', () => {
  expect(
    buildCreditNoteXml(creditEnvelope(), creditContent()).equals(
      buildCreditNoteXml(creditEnvelope(), creditContent()),
    ),
  ).toBe(true);
});

it('escapa los caracteres especiales', async () => {
  const envelope = creditEnvelope();
  const content = creditContent('Cambio & <ajuste>', 'Café & té <frío>');
  const text = xml(envelope, content);
  expect(text).toContain('<motivo>Cambio &amp; &lt;ajuste&gt;</motivo>');
  expect(text).toContain(
    '<descripcion>Café &amp; té &lt;frío&gt;</descripcion>',
  );
  await expectValid(envelope, content);
});

it('incluye las leyendas, el contribuyente especial y el RUC del proveedor', async () => {
  const envelope = creditEnvelope({
    providerRuc: '1790099999001',
    rimpe: 'EMPRENDEDOR',
    withholding: '1',
    special: '5368',
    tradeName: null,
    address: null,
    accounting: true,
  });
  const text = xml(envelope, creditContent());
  expect(text).toContain(
    '<agenteRetencion>1</agenteRetencion><contribuyenteRimpe>CONTRIBUYENTE RÉGIMEN RIMPE</contribuyenteRimpe></infoTributaria>',
  );
  expect(text).toContain(
    '<identificacionComprador>1712345678</identificacionComprador><contribuyenteEspecial>5368</contribuyenteEspecial>' +
      '<obligadoContabilidad>SI</obligadoContabilidad><codDocModificado>',
  );
  expect(text).not.toContain('nombreComercial');
  expect(text).not.toContain('dirEstablecimiento');
  expect(
    text.endsWith(
      '</detalles><infoAdicional><campoAdicional nombre="RUC Proveedor">1790099999001' +
        '</campoAdicional></infoAdicional></notaCredito>',
    ),
  ).toBe(true);
  await expectValid(envelope, creditContent());
});

it('una nota sin comprobante modificado o sin totales se rechaza', () => {
  expect(() =>
    buildCreditNoteXml(
      { ...creditEnvelope(), modified: null },
      creditContent(),
    ),
  ).toThrow();
  expect(() =>
    buildCreditNoteXml({ ...creditEnvelope(), totals: null }, creditContent()),
  ).toThrow();
});
