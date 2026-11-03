import { DocumentKinds } from '../../../src/billing/document-kind.js';
import type { FiscalDocumentRepository } from '../../../src/billing/fiscal-document.repository.js';
import { InvoiceKind } from '../../../src/billing/invoice-kind.js';
import { DOCUMENT_TYPES } from '../../../src/xml/document-type.js';

// Traducción de DocumentKindsTest: el registro encuentra cada tipo y no admite dos piezas para el mismo.
const noRepository = null as unknown as FiscalDocumentRepository;

describe('DocumentKinds', () => {
  it('encuentra la factura', () => {
    const invoice = new InvoiceKind(noRepository);
    const kinds = new DocumentKinds();
    kinds.register(invoice);
    expect(kinds.find(DOCUMENT_TYPES.INVOICE.code)).toBe(invoice);
    expect(kinds.find(DOCUMENT_TYPES.CREDIT_NOTE.code)).toBeNull();
  });

  it('un tipo repetido falla y nombra el tipo', () => {
    const kinds = new DocumentKinds();
    kinds.register(new InvoiceKind(noRepository));
    expect(() => kinds.register(new InvoiceKind(noRepository))).toThrow(
      'Hay dos implementaciones para el tipo de comprobante INVOICE',
    );
  });
});
