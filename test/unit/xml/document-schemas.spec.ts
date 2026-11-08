import { readFileSync, statSync } from 'node:fs';
import {
  DOCUMENT_SCHEMAS,
  DOCUMENT_TYPES,
  XMLDSIG_FILE,
  documentSchemaOf,
  documentTypeOf,
  sampleFile,
  xsdFile,
} from '../../../src/xml/document-type.js';
import { XsdValidator } from '../../../src/xml/xsd-validator.js';

// Traducción de DocumentSchemasTest (la compilación de los XSD) y de ClasspathSchemaResolverTest.resolvesTheSharedXmldsig.
const schemas = Object.values(DOCUMENT_SCHEMAS);
const validator = new XsdValidator();
const slash = (path: string) => path.replaceAll('\\', '/');

it('son trece esquemas y seis tipos, con los nombres del enum de Java', () => {
  expect(schemas).toHaveLength(13);
  expect(Object.keys(DOCUMENT_SCHEMAS)).toEqual(schemas.map((s) => s.name));
  expect(Object.values(DOCUMENT_TYPES).map((t) => t.name)).toEqual([
    'INVOICE',
    'PURCHASE_LIQUIDATION',
    'CREDIT_NOTE',
    'DEBIT_NOTE',
    'REMISSION_GUIDE',
    'RETENTION_RECEIPT',
  ]);
});

it.each(schemas.map((s) => [s.name, s] as const))(
  '%s: el XSD y el ejemplo existen y el XSD compila',
  async (_name, schema) => {
    expect(statSync(xsdFile(schema)).isFile()).toBe(true);
    const result = await validator.validate(
      readFileSync(sampleFile(schema)),
      schema,
    );
    // Validar contra el XSD lo compila; el único ejemplo inválido es el 2.0.0 (incoTermFactura vacío).
    if (schema === DOCUMENT_SCHEMAS.INVOICE_2_0_0) {
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('incoTermFactura'))).toBe(
        true,
      );
    } else {
      expect(result.errors).toEqual([]);
    }
  },
);

it('documentSchemaOf rechaza versiones desconocidas', () => {
  expect(documentSchemaOf(DOCUMENT_TYPES.RETENTION_RECEIPT, '2.0.0')).toBe(
    DOCUMENT_SCHEMAS.RETENTION_RECEIPT_2_0_0,
  );
  expect(() => documentSchemaOf(DOCUMENT_TYPES.INVOICE, '3.0.0')).toThrow(
    'Versión de esquema desconocida para INVOICE: 3.0.0',
  );
  // La nota de débito solo se publica en 1.0.0.
  expect(() => documentSchemaOf(DOCUMENT_TYPES.DEBIT_NOTE, '1.1.0')).toThrow();
});

it('los recursos siguen la carpeta del tipo y el nombre del SRI', () => {
  expect(slash(xsdFile(DOCUMENT_SCHEMAS.CREDIT_NOTE_1_1_0))).toMatch(
    /\/resources\/xsd\/credit-note\/1\.1\.0\/NotaCredito_V1\.1\.0\.xsd$/,
  );
  expect(slash(sampleFile(DOCUMENT_SCHEMAS.INVOICE_1_0_0))).toMatch(
    /\/resources\/xsd\/invoice\/1\.0\.0\/factura_V1\.0\.0\.xml$/,
  );
});

it('los tipos llevan el código del SRI', () => {
  expect(documentTypeOf('07')).toBe(DOCUMENT_TYPES.RETENTION_RECEIPT);
  expect(DOCUMENT_TYPES.PURCHASE_LIQUIDATION.code).toBe('03');
  expect(() => documentTypeOf('02')).toThrow(
    'Tipo de comprobante desconocido: 02',
  );
});

it('el XMLDSig compartido conserva su tamaño original', () => {
  expect(statSync(XMLDSIG_FILE).size).toBe(10292);
});
