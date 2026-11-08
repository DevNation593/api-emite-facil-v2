import { readFileSync } from 'node:fs';
import { requireIdempotencyKey } from '../../../src/billing/idempotency-key.js';
import { invoiceRequestView, IssueInvoiceDto } from '../../../src/billing/invoice.dto.js';
import { jacksonJson, requestHash } from '../../../src/billing/request-hash.js';
import { ApiException } from '../../../src/common/api-exception.js';
import { recordNumberSource } from '../../../src/common/json-source.js';
import { validationPipe } from '../../../src/common/validation.js';

/*
 * La huella de la petición debe ser la de Java (InvoiceController.requestHash: SHA-256 de
 * JsonMapper.writeValueAsBytes del record ya leído). Las huellas esperadas salen de la API Java
 * (target/classes de ca53bca) leyendo cada cuerpo con su JsonMapper y escribiendo el record.
 */
const lines = readFileSync(new URL('./request-hash.bodies.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '');

async function hashOf(text: string): Promise<string> {
  const body = JSON.parse(text, recordNumberSource) as unknown;
  const dto = (await validationPipe.transform(body, { type: 'body', metatype: IssueInvoiceDto })) as IssueInvoiceDto;
  return requestHash(invoiceRequestView(dto));
}

const JAVA_HASHES = [
  'c7d419e2e256d75acab5cf67c53498228d5f1b20cf74ea9b30ea2d3b0f412c64',
  // El mismo cuerpo reordenado, con "quantity": 1 como número y propiedades desconocidas.
  'c7d419e2e256d75acab5cf67c53498228d5f1b20cf74ea9b30ea2d3b0f412c64',
  // UUID en mayúsculas, fecha como arreglo, números con su texto, comillas, emoji y sustituto suelto.
  '0f464b0697cd41c775a3c51e22510338c0cc566f469cb667d6926d0ef1510f7b',
  // Fecha como día de época y replacesDocumentId vacío (null).
  'fb40d5588f129772cc8704389c4df8cbf211119d2e62eed581f47b7763fe21bc',
];

it.each(lines.map((line, i) => [i, line] as const))('cuerpo %i: misma huella que Java', async (i, line) => {
  expect(await hashOf(line)).toBe(JAVA_HASHES[i]);
});

it('la vista lleva las propiedades de los records de Java, en su orden y con los null', async () => {
  const body = JSON.parse(lines[0]!, recordNumberSource) as unknown;
  const dto = (await validationPipe.transform(body, { type: 'body', metatype: IssueInvoiceDto })) as IssueInvoiceDto;
  expect(jacksonJson(invoiceRequestView(dto))).toBe(
    '{"taxpayerId":"11111111-1111-4111-8111-111111111111","establishmentCode":"001","emissionPointCode":"001",' +
      '"customerId":"22222222-2222-4222-8222-222222222222","issueDate":null,"currency":null,"lines":[{"productId":' +
      '"33333333-3333-4333-8333-333333333333","quantity":"1","unitPrice":null,"discount":null}],"payments":[{"methodCode":' +
      '"20","amount":"11.50","term":null,"timeUnit":null}],"replacesDocumentId":null}',
  );
});

it('escribe las cadenas como el generador UTF-8 de Jackson', () => {
  // Controles en hexadecimal mayúsculo, pares sustitutos en UTF-8 y sustitutos sueltos escapados.
  expect(jacksonJson(['a\u001f\n"\\', 'd\u{1F600}𐀀x\udc00', ' \u007f/'])).toBe(
    '["a\\u001F\\n\\"\\\\","d\u{1F600}𐀀x\\uDC00"," \u007f/"]',
  );
  expect(jacksonJson({ a: null, b: true, c: [] })).toBe('{"a":null,"b":true,"c":[]}');
});

describe('cabecera Idempotency-Key', () => {
  const problem = (key: string | undefined) => {
    try {
      requireIdempotencyKey(key);
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(ApiException);
      const e = error as ApiException;
      return { status: e.status, errorCode: e.errorCode, detail: e.detail };
    }
  };
  const REQUIRED = {
    status: 400,
    errorCode: 'IDEMPOTENCY_KEY_REQUIRED',
    detail: 'La emisión requiere la cabecera Idempotency-Key',
  };
  const INVALID = {
    status: 400,
    errorCode: 'IDEMPOTENCY_KEY_INVALID',
    detail: 'La cabecera Idempotency-Key admite hasta 100 caracteres: letras, dígitos y . _ : -',
  };

  it.each([undefined, '', '   ', '\t'])('%j falta', (key) => {
    expect(problem(key)).toEqual(REQUIRED);
  });

  it.each(['x'.repeat(101), 'a/b', 'con espacio', 'ñ', 'a, b', 'a,b'])('%j no es válida', (key) => {
    expect(problem(key)).toEqual(INVALID);
  });

  it.each(['x'.repeat(100), 'A-z_0.9:1', '550e8400-e29b-41d4-a716-446655440000'])('%j es válida', (key) => {
    expect(problem(key)).toBeNull();
  });
});
