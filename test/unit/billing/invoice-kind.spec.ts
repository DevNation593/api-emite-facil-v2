import {
  documentNumber,
  type DocumentEnvelope,
} from '../../../src/billing/document-envelope.js';
import type { FiscalDocumentRepository } from '../../../src/billing/fiscal-document.repository.js';
import {
  InvoiceKind,
  type InvoiceBody,
} from '../../../src/billing/invoice-kind.js';
import {
  documentTypeOf,
  DOCUMENT_SCHEMAS,
} from '../../../src/xml/document-type.js';
import {
  buildInvoiceXml,
  type InvoiceXmlData,
} from '../../../src/xml/invoice-xml.js';
import { invoiceData } from '../xml/invoice-fixtures.js';

// Traducción de InvoiceKindTest: la factura delega en el generador de siempre sin cambiar un byte.
const kind = new InvoiceKind(null as unknown as FiscalDocumentRepository);

function envelope(data: InvoiceXmlData): DocumentEnvelope {
  return {
    type: documentTypeOf(data.documentType),
    environment: data.environment,
    issuer: {
      legalName: data.issuerLegalName,
      tradeName: data.issuerTradeName,
      ruc: data.issuerRuc,
      headOfficeAddress: data.headOfficeAddress,
      establishmentAddress: data.establishmentAddress,
      accountingRequired: data.accountingRequired,
      specialTaxpayerCode: data.specialTaxpayerCode,
      withholdingAgentCode: data.withholdingAgentCode,
      rimpeRegime: data.rimpeRegime,
      phone: null,
    },
    accessKey: data.accessKey,
    establishmentCode: data.establishmentCode,
    emissionPointCode: data.emissionPointCode,
    sequence: data.sequence,
    issueDate: data.issueDate,
    recipient: {
      idType: data.customerIdType,
      idNumber: data.customerIdNumber,
      name: data.customerName,
      address: data.customerAddress,
      email: 'cliente@example.test',
      phone: null,
    },
    totals: {
      subtotal: data.subtotal,
      totalDiscount: data.totalDiscount,
      totalTax: null,
      total: data.total,
    },
    modified: null,
    providerRuc: data.providerRuc,
  };
}

function body(data: InvoiceXmlData): InvoiceBody {
  return {
    lines: data.lines.map((line) => ({ productId: null, ...line })),
    taxes: data.taxes,
    payments: data.payments,
  };
}

describe('InvoiceKind', () => {
  it('el XML es el del generador de la factura', () => {
    const data = invoiceData();
    expect(
      kind.buildXml(envelope(data), body(data)).equals(buildInvoiceXml(data)),
    ).toBe(true);
  });

  it('el XML conserva los datos opcionales del emisor', () => {
    const data = invoiceData({
      withholdingAgentCode: '1',
      specialTaxpayerCode: '5368',
      accountingRequired: true,
      rimpeRegime: 'EMPRENDEDOR',
      providerRuc: '1790099999001',
    });
    expect(
      kind.buildXml(envelope(data), body(data)).equals(buildInvoiceXml(data)),
    ).toBe(true);
  });

  it('nombres y esquema', () => {
    expect(kind.type.code).toBe('01');
    expect(kind.schema).toBe(DOCUMENT_SCHEMAS.INVOICE_1_1_0);
    expect(kind.displayName).toBe('Factura');
    expect(kind.fileStem).toBe('factura');
    expect(kind.auditReserved).toBe('INVOICE_RESERVED');
    expect(kind.contentJson(body(invoiceData()))).toBeNull();
  });

  it('el número es establecimiento, punto y secuencial de nueve dígitos', () => {
    expect(documentNumber(envelope(invoiceData()))).toBe('001-002-000000123');
  });
});
