import { readFileSync } from 'node:fs';
import { DocumentXmlCheck } from '../../../src/billing/document-xml-check.js';
import { DOCUMENT_SCHEMAS } from '../../../src/xml/document-type.js';
import { XsdValidator } from '../../../src/xml/xsd-validator.js';

// Traducción de DocumentXmlCheckTest.
const check = new DocumentXmlCheck(new XsdValidator());
const valid = readFileSync(
  new URL('../../golden/xades/factura-estandar/unsigned.xml', import.meta.url),
  'utf8',
);
const schema = DOCUMENT_SCHEMAS.INVOICE_1_1_0;

it('un XML válido no tiene problema', async () => {
  expect(await check.problem(Buffer.from(valid, 'utf8'), schema)).toBeNull();
});

it('un XML de más de 320 KB se informa', async () => {
  expect(await check.problem(Buffer.alloc(321 * 1024), schema)).toBe(
    'El XML supera el tamaño máximo de envío de 320 KB',
  );
  // Justo en el límite no se rechaza por tamaño (aquí falla por ilegible).
  expect(await check.problem(Buffer.alloc(320 * 1024), schema)).not.toContain(
    '320 KB',
  );
});

it('las violaciones del sobre salen ordenadas y separadas por coma', async () => {
  const wrongCode = Buffer.from(
    valid.replace('<codDoc>01</codDoc>', '<codDoc>04</codDoc>'),
    'utf8',
  );
  expect(await check.problem(wrongCode, schema)).toBe(
    'ACCESS_KEY_MISMATCH, COD_DOC_MISMATCH',
  );
});

it('los errores del XSD salen unidos con punto y coma', async () => {
  const broken = Buffer.from(
    valid.replaceAll('razonSocial>', 'razonSocialX>'),
    'utf8',
  );
  const problem = await check.problem(broken, schema);
  expect(problem).not.toBeNull();
  expect(problem).toMatch(/ \(línea \d+\)/);
  expect(problem).not.toContain('MISMATCH');
});
