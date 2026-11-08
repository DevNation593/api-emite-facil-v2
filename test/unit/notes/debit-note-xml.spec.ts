import { checkEnvelope } from '../../../src/xml/envelope-rules.js';
import { XsdValidator } from '../../../src/xml/xsd-validator.js';
import {
  buildDebitNoteXml,
  DEBIT_NOTE_SCHEMA,
} from '../../../src/notes/debit-note-content.js';
import {
  accessKeyOf,
  d,
  debitContent,
  debitEnvelope,
} from './note-fixtures.js';

// Traducción de DebitNoteXmlBuilderTest: formato de nota de débito versión 1.0.0 (XSD NotaDebito_V1.0.0).
const validator = new XsdValidator();
const ACCESS_KEY = accessKeyOf('05');

const EXPECTED =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<notaDebito id="comprobante" version="1.0.0">' +
  '<infoTributaria><ambiente>1</ambiente><tipoEmision>1</tipoEmision>' +
  '<razonSocial>Comercial Andina S.A.</razonSocial><nombreComercial>Andina</nombreComercial>' +
  `<ruc>1790012345001</ruc><claveAcceso>${ACCESS_KEY}</claveAcceso>` +
  '<codDoc>05</codDoc><estab>001</estab><ptoEmi>002</ptoEmi><secuencial>000000007</secuencial>' +
  '<dirMatriz>Av. Amazonas N34-12, Quito</dirMatriz></infoTributaria>' +
  '<infoNotaDebito><fechaEmision>19/10/2026</fechaEmision>' +
  '<dirEstablecimiento>Av. 10 de Agosto, Quito</dirEstablecimiento>' +
  '<tipoIdentificacionComprador>05</tipoIdentificacionComprador>' +
  '<razonSocialComprador>María Pérez</razonSocialComprador>' +
  '<identificacionComprador>1712345678</identificacionComprador>' +
  '<obligadoContabilidad>NO</obligadoContabilidad>' +
  '<codDocModificado>01</codDocModificado><numDocModificado>001-001-000000123</numDocModificado>' +
  '<fechaEmisionDocSustento>01/10/2026</fechaEmisionDocSustento>' +
  '<totalSinImpuestos>15.00</totalSinImpuestos><impuestos>' +
  '<impuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje><tarifa>15.00</tarifa>' +
  '<baseImponible>15.00</baseImponible><valor>2.25</valor></impuesto></impuestos>' +
  '<valorTotal>17.25</valorTotal>' +
  '<pagos><pago><formaPago>01</formaPago><total>17.25</total></pago></pagos></infoNotaDebito>' +
  '<motivos><motivo><razon>Intereses de mora</razon><valor>10.00</valor></motivo>' +
  '<motivo><razon>Gastos de cobranza</razon><valor>5.00</valor></motivo></motivos></notaDebito>';

it('produce el XML esperado', () => {
  expect(
    buildDebitNoteXml(debitEnvelope(), debitContent()).toString('utf8'),
  ).toBe(EXPECTED);
});

it('es válida contra el XSD y las reglas del sobre, con el RUC del proveedor', async () => {
  const bytes = buildDebitNoteXml(
    debitEnvelope('1790099999001'),
    debitContent('Cambio & <ajuste>'),
  );
  const result = await validator.validate(bytes, DEBIT_NOTE_SCHEMA);
  expect(result.errors).toEqual([]);
  expect([...checkEnvelope(bytes, DEBIT_NOTE_SCHEMA)]).toEqual([]);
  const text = bytes.toString('utf8');
  expect(text).toContain('<razon>Cambio &amp; &lt;ajuste&gt;</razon>');
  expect(
    text.endsWith(
      '</motivos><infoAdicional><campoAdicional nombre="RUC Proveedor">1790099999001' +
        '</campoAdicional></infoAdicional></notaDebito>',
    ),
  ).toBe(true);
});

it('el plazo va después del total del pago', async () => {
  const base = debitContent();
  const content = {
    ...base,
    payments: [
      { methodCode: '01', amount: d('17.25'), term: d('2'), timeUnit: 'meses' },
    ],
  };
  const bytes = buildDebitNoteXml(debitEnvelope(), content);
  expect(bytes.toString('utf8')).toContain(
    '<pago><formaPago>01</formaPago><total>17.25</total><plazo>2.00</plazo><unidadTiempo>meses</unidadTiempo></pago>',
  );
  expect((await validator.validate(bytes, DEBIT_NOTE_SCHEMA)).errors).toEqual(
    [],
  );
});

it('los mismos datos dan los mismos bytes', () => {
  expect(
    buildDebitNoteXml(debitEnvelope(), debitContent()).equals(
      buildDebitNoteXml(debitEnvelope(), debitContent()),
    ),
  ).toBe(true);
});
