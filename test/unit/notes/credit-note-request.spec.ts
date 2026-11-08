import { jacksonJson } from '../../../src/billing/request-hash.js';
import { ApiException } from '../../../src/common/api-exception.js';
import { recordNumberSource } from '../../../src/common/json-source.js';
import { validationPipe } from '../../../src/common/validation.js';
import { creditNoteCommand, creditNoteRequestView, IssueCreditNoteDto } from '../../../src/notes/credit-note.dto.js';
import { requireNotLater, requireOneModifiedDocument } from '../../../src/notes/modified-invoices.js';

/*
 * Cuerpo de POST /credit-notes (records de notes/CreditNoteController.java): lo que Jackson lee, lo que
 * escribe para la huella y las reglas de ModifiedInvoices que no tocan la base.
 */
const TAXPAYER = '11111111-1111-4111-8111-111111111111';
const INVOICE = '22222222-2222-4222-8222-222222222222';

async function read(text: string): Promise<IssueCreditNoteDto> {
  const body = JSON.parse(text, recordNumberSource) as unknown;
  return (await validationPipe.transform(body, { type: 'body', metatype: IssueCreditNoteDto })) as IssueCreditNoteDto;
}

it('la vista lleva los componentes de los records en su orden, con los null y el texto recibido', async () => {
  const dto = await read(
    `{"lines":[{"quantity":1.50,"invoiceLineNo":"01","x":true}],"reason":"  Devolución  ",` +
      `"emissionPointCode":"001","establishmentCode":"001","invoiceId":"${INVOICE.toUpperCase()}",` +
      `"taxpayerId":"${TAXPAYER}","issueDate":[2026,1,5]}`,
  );
  expect(jacksonJson(creditNoteRequestView(dto))).toBe(
    `{"taxpayerId":"${TAXPAYER}","establishmentCode":"001","emissionPointCode":"001","issueDate":"2026-01-05",` +
      `"reason":"  Devolución  ","invoiceId":"${INVOICE}","modifiedDocument":null,"customerId":null,` +
      `"lines":[{"invoiceLineNo":1,"productId":null,"quantity":"1.50","unitPrice":null,"discount":null}]}`,
  );
});

it('el documento escrito a mano va con sus tres componentes', async () => {
  const dto = await read(
    `{"taxpayerId":"${TAXPAYER}","establishmentCode":"001","emissionPointCode":"001","reason":"R",` +
      `"modifiedDocument":{"issueDate":20000,"number":"001-002-000000123","code":"01","documentId":"x"},` +
      `"customerId":"${INVOICE}","lines":[{"productId":"${INVOICE}","quantity":"1","unitPrice":"2","discount":"0.5"}]}`,
  );
  expect(jacksonJson(creditNoteRequestView(dto))).toBe(
    `{"taxpayerId":"${TAXPAYER}","establishmentCode":"001","emissionPointCode":"001","issueDate":null,` +
      `"reason":"R","invoiceId":null,"modifiedDocument":{"code":"01","number":"001-002-000000123",` +
      `"issueDate":"2024-10-04"},"customerId":"${INVOICE}","lines":[{"invoiceLineNo":null,` +
      `"productId":"${INVOICE}","quantity":"1","unitPrice":"2","discount":"0.5"}]}`,
  );
  const command = creditNoteCommand(dto);
  expect(command.writtenInvoice).toEqual({ number: '001-002-000000123', issueDate: '2024-10-04' });
  expect(command.lines[0]!.unitPrice!.toString()).toBe('2');
  expect(command.lines[0]!.discount!.toString()).toBe('0.5');
});

it('el comando lleva el motivo recortado y las cantidades como BigDecimal', async () => {
  const dto = await read(
    `{"taxpayerId":"${TAXPAYER}","establishmentCode":"001","emissionPointCode":"001","reason":" \u2003Motivo ",` +
      `"invoiceId":"${INVOICE}","lines":[{"invoiceLineNo":1.9,"quantity":"0.5"}]}`,
  );
  const command = creditNoteCommand(dto);
  expect(command.reason).toBe('Motivo');
  expect(command.lines[0]).toMatchObject({ invoiceLineNo: 1, productId: null, unitPrice: null, discount: null });
  expect(command.lines[0]!.quantity.toString()).toBe('0.5');
  expect(command.issueDate).toBeNull();
});

it('invoiceLineNo fuera del rango de int o que no es un número no se lee', async () => {
  for (const value of ['2147483648', 'true', '"uno"']) {
    await expect(
      read(
        `{"taxpayerId":"${TAXPAYER}","establishmentCode":"001","emissionPointCode":"001","reason":"R",` +
          `"invoiceId":"${INVOICE}","lines":[{"invoiceLineNo":${value},"quantity":"1"}]}`,
      ),
    ).rejects.toMatchObject({ errorCode: 'MALFORMED_REQUEST' });
  }
});

describe('requireOneModifiedDocument', () => {
  const written = { number: '001-002-000000123', issueDate: '2024-01-15' };
  it.each([
    [INVOICE, null, null, true],
    [null, written, TAXPAYER, true],
    [null, null, null, false],
    [INVOICE, written, TAXPAYER, false],
    [INVOICE, null, TAXPAYER, false],
    [null, written, null, false],
    [null, null, TAXPAYER, false],
  ] as const)('invoiceId %s, escrita %o, cliente %s: válida %s', (invoiceId, w, customerId, valid) => {
    const call = () => requireOneModifiedDocument(invoiceId, w, customerId);
    if (valid) expect(call).not.toThrow();
    else
      expect(call).toThrow(
        expect.objectContaining({
          status: 400,
          errorCode: 'MODIFIED_DOCUMENT_REQUIRED',
          detail: 'La nota lleva invoiceId, o modifiedDocument con customerId; no las dos cosas ni ninguna',
        }) as ApiException,
      );
  });
});

describe('requireNotLater', () => {
  it.each([
    ['2026-01-02', '2026-01-01', false],
    ['2026-01-01', '2026-01-01', true],
    ['-0001-01-01', '2026-01-01', true],
    ['+10000-01-01', '2026-01-01', false],
  ])('%s frente a %s', (modified, note, valid) => {
    const call = () => requireNotLater(modified, note);
    if (valid) expect(call).not.toThrow();
    else expect(call).toThrow(expect.objectContaining({ status: 422, errorCode: 'INVALID_MODIFIED_DOCUMENT_DATE' }) as ApiException);
  });
});
