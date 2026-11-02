import { readFileSync } from 'node:fs';
import { AccessKeyParts } from '../../../src/sequence/access-key-parts.js';
import {
  DOCUMENT_SCHEMAS,
  sampleFile,
  type DocumentSchema,
} from '../../../src/xml/document-type.js';
import {
  checkEnvelope,
  type EnvelopeViolation,
} from '../../../src/xml/envelope-rules.js';

// Traducción de EnvelopeRulesTest.
const ACCESS_KEY = '0710202601179001234500110010020000001231234567816';

/** Comprobante mínimo coherente con la clave de acceso del doc 06 (07/10/2026, 001-002, secuencial 123). */
const VALID =
  '<factura id="comprobante" version="2.1.0"><infoTributaria>' +
  '<ambiente>1</ambiente><tipoEmision>1</tipoEmision><ruc>1790012345001</ruc><claveAcceso>' +
  ACCESS_KEY +
  '</claveAcceso><codDoc>01</codDoc><estab>001</estab>' +
  '<ptoEmi>002</ptoEmi><secuencial>000000123</secuencial></infoTributaria>' +
  '<infoFactura><fechaEmision>07/10/2026</fechaEmision></infoFactura></factura>';

const check = (
  xml: string,
  schema: DocumentSchema = DOCUMENT_SCHEMAS.INVOICE_2_1_0,
) => [...checkEnvelope(Buffer.from(xml, 'utf8'), schema)].sort();

it('el ejemplo oficial incumple lo que el XSD no revisa', () => {
  const violations = check(
    readFileSync(sampleFile(DOCUMENT_SCHEMAS.INVOICE_2_1_0), 'utf8'),
  );
  expect(violations).toEqual(
    expect.arrayContaining([
      'COD_DOC_MISMATCH',
      'VERSION_MISMATCH',
      'SCHEMA_LOCATION_PRESENT',
    ]),
  );
  expect(
    violations.some(
      (v) => v === 'ACCESS_KEY_INVALID' || v === 'ACCESS_KEY_MISMATCH',
    ),
  ).toBe(true);
});

it('un sobre correcto pasa', () => {
  expect(check(VALID)).toEqual([]);
});

it('falta el id', () => {
  expect(check(VALID.replace(' id="comprobante"', ''))).toEqual(['ID_MISSING']);
});

it('la versión de otro esquema', () => {
  expect(check(VALID.replace('version="2.1.0"', 'version="1.1.0"'))).toEqual([
    'VERSION_MISMATCH',
  ]);
});

it('un tipo de comprobante distinto de la factura', () => {
  expect(
    check(VALID.replace('<codDoc>01</codDoc>', '<codDoc>04</codDoc>')),
  ).toEqual(['ACCESS_KEY_MISMATCH', 'COD_DOC_MISMATCH']);
});

it('schemaLocation en un elemento hijo', () => {
  const xml = VALID.replace(
    '<infoTributaria>',
    '<infoTributaria xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xsi:noNamespaceSchemaLocation="http://127.0.0.1:9/evil.xsd">',
  );
  expect(check(xml)).toEqual(['SCHEMA_LOCATION_PRESENT']);
});

it('xsi:schemaLocation con otro prefijo también cuenta, y uno sin espacio de nombres xsi no', () => {
  const withPrefix = VALID.replace(
    '<factura ',
    '<factura xmlns:otro="http://www.w3.org/2001/XMLSchema-instance" otro:schemaLocation="a b" ',
  );
  expect(check(withPrefix)).toEqual(['SCHEMA_LOCATION_PRESENT']);
  expect(
    check(VALID.replace('<factura ', '<factura schemaLocation="a" ')),
  ).toEqual([]);
});

it('detecta una clave de acceso inválida', () => {
  expect(
    check(VALID.replace(ACCESS_KEY, `${ACCESS_KEY.slice(0, 48)}7`)),
  ).toEqual(['ACCESS_KEY_INVALID']);
  expect(check(VALID.replace(ACCESS_KEY, '123'))).toEqual([
    'ACCESS_KEY_INVALID',
  ]);
  expect(
    check(VALID.replace(`<claveAcceso>${ACCESS_KEY}</claveAcceso>`, '')),
  ).toEqual(['ACCESS_KEY_INVALID']);
});

it.each([
  ['<secuencial>000000123</secuencial>', '<secuencial>000000124</secuencial>'],
  ['<ruc>1790012345001</ruc>', '<ruc>1790012345002</ruc>'],
  [
    '<fechaEmision>07/10/2026</fechaEmision>',
    '<fechaEmision>08/10/2026</fechaEmision>',
  ],
  [
    '<fechaEmision>07/10/2026</fechaEmision>',
    '<fechaEmision>2026-10-07</fechaEmision>',
  ],
  ['<ambiente>1</ambiente>', '<ambiente>2</ambiente>'],
  ['<estab>001</estab>', '<estab>002</estab>'],
  ['<ptoEmi>002</ptoEmi>', '<ptoEmi>001</ptoEmi>'],
  ['<tipoEmision>1</tipoEmision>', '<tipoEmision>2</tipoEmision>'],
  ['<infoFactura><fechaEmision>07/10/2026</fechaEmision></infoFactura>', ''],
])('una clave que no corresponde al comprobante: %s -> %s', (from, to) => {
  expect(check(VALID.replace(from, to))).toEqual(['ACCESS_KEY_MISMATCH']);
});

it('un elemento fuera de su lugar no cuenta como dato de la cabecera', () => {
  // Un claveAcceso anidado en otro elemento no sustituye al de infoTributaria.
  const xml = VALID.replace(
    `<claveAcceso>${ACCESS_KEY}</claveAcceso>`,
    '',
  ).replace(
    '</infoFactura>',
    `<otro><claveAcceso>${ACCESS_KEY}</claveAcceso></otro></infoFactura>`,
  );
  expect(check(xml)).toEqual(['ACCESS_KEY_INVALID']);
});

it('el texto de la cabecera se junta entre CDATA y entidades', () => {
  const xml = VALID.replace(
    `<claveAcceso>${ACCESS_KEY}</claveAcceso>`,
    `<claveAcceso>${ACCESS_KEY.slice(0, 20)}<![CDATA[${ACCESS_KEY.slice(20)}]]></claveAcceso>`,
  );
  expect(check(xml)).toEqual([]);
});

it('un XML ilegible lanza', () => {
  expect(() => check('<factura')).toThrow('XML de comprobante ilegible: ');
  expect(() => check(`<!DOCTYPE factura>${VALID}`)).toThrow(
    'XML de comprobante ilegible: ',
  );
});

function coherentSample(schema: DocumentSchema): string {
  const xml = readFileSync(sampleFile(schema), 'utf8')
    .replace(/\s+xsi:noNamespaceSchemaLocation="[^"]*"/, '')
    .replace('<codDoc>00</codDoc>', `<codDoc>${schema.type.code}</codDoc>`)
    .replace('version="version0"', `version="${schema.version}"`)
    .replace(
      '<secuencial>000000000</secuencial>',
      '<secuencial>000000001</secuencial>',
    );
  const key = new AccessKeyParts({
    issueDate: '2000-01-01',
    documentType: schema.type.code,
    ruc: '0000000000001',
    environment: '1',
    establishment: '000',
    emissionPoint: '000',
    sequence: 1,
    numericCode: '12345678',
    emissionType: '1',
  }).toAccessKey();
  return xml.replace(
    '<claveAcceso>0000000000000000000000000000000000000000000000000</claveAcceso>',
    `<claveAcceso>${key}</claveAcceso>`,
  );
}

it.each(Object.values(DOCUMENT_SCHEMAS).map((s) => [s.name, s] as const))(
  '%s acepta su código y su versión',
  (_name, schema) => {
    expect(check(coherentSample(schema), schema)).toEqual([]);
  },
);

it('rechaza el código de otro tipo', () => {
  const schema = DOCUMENT_SCHEMAS.CREDIT_NOTE_1_1_0;
  const violations = check(
    coherentSample(schema).replace(
      '<codDoc>04</codDoc>',
      '<codDoc>01</codDoc>',
    ),
    schema,
  );
  expect(violations).toContain('COD_DOC_MISMATCH' satisfies EnvelopeViolation);
});

it('rechaza la raíz de otro tipo', () => {
  const violations = check(
    coherentSample(DOCUMENT_SCHEMAS.DEBIT_NOTE_1_0_0),
    DOCUMENT_SCHEMAS.CREDIT_NOTE_1_1_0,
  );
  expect(violations).toContain('ROOT_MISMATCH' satisfies EnvelopeViolation);
});

it('la clave de la guía de remisión se comprueba sin fecha de emisión', () => {
  const schema = DOCUMENT_SCHEMAS.REMISSION_GUIDE_1_1_0;
  const xml = coherentSample(schema);
  expect(check(xml, schema)).toEqual([]);
  expect(
    check(
      xml.replace('<ruc>0000000000001</ruc>', '<ruc>0000000000002</ruc>'),
      schema,
    ),
  ).toEqual(['ACCESS_KEY_MISMATCH']);
});
