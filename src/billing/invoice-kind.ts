import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../database/schema.js';
import { DOCUMENT_TYPES } from '../xml/document-type.js';
import {
  buildInvoiceXml,
  INVOICE_SCHEMA,
  type InvoiceXmlData,
} from '../xml/invoice-xml.js';
import type { DocumentKind } from './document-kind.js';
import {
  requireAmount,
  requireTotals,
  type DocumentEnvelope,
} from './document-envelope.js';
import type {
  FiscalDocumentRepository,
  InvoiceBody,
} from './fiscal-document.repository.js';

export type { InvoiceBody } from './fiscal-document.repository.js';

/**
 * La factura como tipo de comprobante (billing/InvoiceKind.java). Su contenido vive en las tablas de
 * líneas, impuestos y pagos, no en content; el XML sale del generador de siempre, sin cambiar un byte.
 */
export class InvoiceKind implements DocumentKind<InvoiceBody> {
  readonly type = DOCUMENT_TYPES.INVOICE;
  readonly schema = INVOICE_SCHEMA;
  readonly displayName = 'Factura';
  readonly fileStem = 'factura';
  readonly auditReserved = 'INVOICE_RESERVED';

  constructor(private readonly documents: FiscalDocumentRepository) {}

  contentJson(_content: InvoiceBody): string | null {
    return null;
  }

  reloaded(content: InvoiceBody): InvoiceBody {
    return content;
  }

  saveDetails(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
    content: InvoiceBody,
  ): Promise<void> {
    return this.documents.insertInvoiceBody(trx, tenantId, documentId, content);
  }

  loadContent(
    db: Kysely<DB> | Transaction<DB>,
    tenantId: string,
    documentId: string,
  ): Promise<InvoiceBody> {
    return this.documents.invoiceBody(db, tenantId, documentId);
  }

  buildXml(envelope: DocumentEnvelope, content: InvoiceBody): Buffer {
    return buildInvoiceXml(invoiceXmlData(envelope, content));
  }
}

/** Junta el sobre y el cuerpo en los datos que consume el generador del XML de la factura. */
export function invoiceXmlData(
  envelope: DocumentEnvelope,
  body: InvoiceBody,
): InvoiceXmlData {
  const issuer = envelope.issuer;
  const recipient = envelope.recipient;
  const totals = requireTotals(envelope);
  return {
    environment: envelope.environment,
    issuerLegalName: issuer.legalName,
    issuerTradeName: issuer.tradeName,
    issuerRuc: issuer.ruc,
    accessKey: envelope.accessKey,
    documentType: envelope.type.code,
    establishmentCode: envelope.establishmentCode,
    emissionPointCode: envelope.emissionPointCode,
    sequence: envelope.sequence,
    headOfficeAddress: issuer.headOfficeAddress,
    withholdingAgentCode: issuer.withholdingAgentCode,
    rimpeRegime: issuer.rimpeRegime,
    issueDate: envelope.issueDate,
    establishmentAddress: issuer.establishmentAddress,
    specialTaxpayerCode: issuer.specialTaxpayerCode,
    accountingRequired: issuer.accountingRequired,
    customerIdType: recipient.idType,
    customerName: recipient.name,
    customerIdNumber: recipient.idNumber,
    customerAddress: recipient.address,
    subtotal: requireAmount(totals.subtotal, 'subtotal'),
    totalDiscount: requireAmount(totals.totalDiscount, 'totalDiscount'),
    taxes: body.taxes.map((tax) => ({
      taxCode: tax.taxCode,
      rateCode: tax.rateCode,
      rate: tax.rate,
      base: tax.base,
      amount: tax.amount,
    })),
    total: totals.total,
    lines: body.lines.map((line) => ({
      mainCode: line.mainCode,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discount: line.discount,
      subtotal: line.subtotal,
      taxCode: line.taxCode,
      taxRateCode: line.taxRateCode,
      taxRate: line.taxRate,
      taxAmount: line.taxAmount,
    })),
    payments: body.payments.map((payment) => ({
      methodCode: payment.methodCode,
      amount: payment.amount,
      term: payment.term,
      timeUnit: payment.timeUnit,
    })),
    providerRuc: envelope.providerRuc,
  };
}
