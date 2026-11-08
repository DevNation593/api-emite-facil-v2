import type { BigDecimal } from '../common/big-decimal.js';
import type { CreditNoteContent, CreditNoteLine } from '../notes/credit-note-content.js';
import type { DebitNoteContent } from '../notes/debit-note-content.js';
import type { DocumentEnvelope } from './document-envelope.js';
import type { DocumentRow, LineRow, Links, PaymentRow } from './fiscal-document.repository.js';
import type { TaxTotal } from './invoice-calculator.js';

/*
 * Vistas JSON de la consulta de comprobantes (records de billing/DocumentController.java). Las
 * propiedades van en el orden de los componentes del record; los `null` se serializan.
 */

export interface CustomerView {
  idType: string;
  idNumber: string;
  name: string;
}

export interface TaxView {
  taxCode: string;
  rateCode: string;
  rate: string;
  base: string;
  amount: string;
}

/** `invoiceLineNo` es la línea de la factura que corrige una nota de crédito; nulo en los demás casos. */
export interface LineView {
  lineNo: number;
  invoiceLineNo: number | null;
  productId: string | null;
  mainCode: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  subtotal: string;
  taxCode: string;
  taxRateCode: string;
  taxRate: string;
  taxAmount: string;
}

/** `term` y `timeUnit` son nulos si la forma de pago no lleva plazo. */
export interface PaymentView {
  methodCode: string;
  amount: string;
  term: string | null;
  timeUnit: string | null;
}

export interface ModifiedDocumentView {
  code: string;
  number: string;
  issueDate: string;
  documentId: string | null;
}

export interface ReasonView {
  reason: string;
  value: string;
  taxRateCode: string;
  taxRate: string;
  taxAmount: string;
}

export interface DocumentSummary {
  id: string;
  documentType: string;
  state: string;
  number: string;
  issueDate: string;
  customerName: string;
  total: string | null;
}

export interface DocumentView {
  id: string;
  documentType: string;
  state: string;
  environment: string;
  taxpayerId: string;
  number: string;
  sequence: string;
  accessKey: string;
  issueDate: string;
  currency: string;
  customer: CustomerView;
  subtotal: string | null;
  totalDiscount: string | null;
  taxes: TaxView[];
  totalTax: string | null;
  total: string | null;
  lines: LineView[];
  payments: PaymentView[];
  authorizationNumber: string | null;
  authorizedAt: string | null;
  customerId: string;
  replacesDocumentId: string | null;
  replacedByDocumentId: string | null;
  modifiedDocument: ModifiedDocumentView | null;
  reason: string | null;
  reasons: ReasonView[] | null;
  creditedTotal: string | null;
}

/** Lo propio de cada tipo: la factura lo saca de sus tablas hijas; las notas, de su contenido. */
export interface DocumentParts {
  taxes: TaxView[];
  lines: LineView[];
  payments: PaymentView[];
  reason: string | null;
  reasons: ReasonView[] | null;
}

/** Los totales son opcionales (la guía de remisión no los lleva): nulo sale como nulo. */
export function money(value: BigDecimal | null): string | null {
  return value === null ? null : value.toFixed(2);
}

function formatSequence(row: DocumentRow): string {
  return String(row.sequence).padStart(9, '0');
}

/** Número del comprobante como se imprime: establecimiento-punto-secuencial. */
function formatNumber(row: DocumentRow): string {
  return `${row.establishmentCode}-${row.emissionPointCode}-${formatSequence(row)}`;
}

export function documentSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    documentType: row.documentType,
    state: row.state,
    number: formatNumber(row),
    issueDate: row.issueDate,
    customerName: row.customerName,
    total: money(row.total),
  };
}

export function taxView(tax: TaxTotal): TaxView {
  return {
    taxCode: tax.taxCode,
    rateCode: tax.rateCode,
    rate: tax.rate.toFixed(2),
    base: tax.base.toFixed(2),
    amount: tax.amount.toFixed(2),
  };
}

export function lineView(line: LineRow): LineView {
  return {
    lineNo: line.lineNo,
    invoiceLineNo: null,
    productId: line.productId,
    mainCode: line.mainCode,
    description: line.description,
    quantity: line.quantity.toFixed(6),
    unitPrice: line.unitPrice.toFixed(6),
    discount: line.discount.toFixed(2),
    subtotal: line.subtotal.toFixed(2),
    taxCode: line.taxCode,
    taxRateCode: line.taxRateCode,
    taxRate: line.taxRate.toFixed(2),
    taxAmount: line.taxAmount.toFixed(2),
  };
}

/** Línea de una nota de crédito: numerada desde 1 en su orden y con la línea de la factura que corrige. */
export function creditLineView(lineNo: number, line: CreditNoteLine): LineView {
  return {
    lineNo,
    invoiceLineNo: line.invoiceLineNo,
    productId: line.productId,
    mainCode: line.mainCode,
    description: line.description,
    quantity: line.quantity.toFixed(6),
    unitPrice: line.unitPrice.toFixed(6),
    discount: line.discount.toFixed(2),
    subtotal: line.subtotal.toFixed(2),
    taxCode: line.taxCode,
    taxRateCode: line.taxRateCode,
    taxRate: line.taxRate.toFixed(2),
    taxAmount: line.taxAmount.toFixed(2),
  };
}

/** Lo propio de una nota de crédito, de su contenido: el motivo, sus líneas e impuestos y ningún pago. */
export function creditNoteParts(content: CreditNoteContent): DocumentParts {
  return {
    taxes: content.taxes.map(taxView),
    lines: content.lines.map((line, i) => creditLineView(i + 1, line)),
    payments: [],
    reason: content.reason,
    reasons: null,
  };
}

/** Lo propio de una nota de débito, de su contenido: los motivos con su IVA, los impuestos y el pago; sin líneas. */
export function debitNoteParts(content: DebitNoteContent): DocumentParts {
  return {
    taxes: content.taxes.map(taxView),
    lines: [],
    payments: content.payments.map((payment) => ({
      methodCode: payment.methodCode,
      amount: payment.amount.toFixed(2),
      term: payment.term === null ? null : payment.term.toFixed(2),
      timeUnit: payment.timeUnit,
    })),
    reason: null,
    reasons: content.reasons.map(
      (reason): ReasonView => ({
        reason: reason.reason,
        value: reason.value.toFixed(2),
        taxRateCode: reason.taxRateCode,
        taxRate: reason.taxRate.toFixed(2),
        taxAmount: reason.taxAmount.toFixed(2),
      }),
    ),
  };
}

export function paymentView(payment: PaymentRow): PaymentView {
  return {
    methodCode: payment.methodCode,
    amount: payment.amount.toFixed(2),
    term: payment.term === null ? null : payment.term.toFixed(2),
    timeUnit: payment.timeUnit,
  };
}

/**
 * `creditedTotal` solo se pide para las facturas (`null` en los demás tipos): es lo que suman sus
 * notas de crédito vigentes.
 */
export function documentView(
  row: DocumentRow,
  links: Links,
  envelope: DocumentEnvelope | null,
  parts: DocumentParts,
  creditedTotal: BigDecimal | null = null,
): DocumentView {
  const modified = envelope?.modified ?? null;
  return {
    id: row.id,
    documentType: row.documentType,
    state: row.state,
    environment: row.environment,
    taxpayerId: row.taxpayerId,
    number: formatNumber(row),
    sequence: formatSequence(row),
    accessKey: row.accessKey,
    issueDate: row.issueDate,
    currency: row.currency,
    customer: { idType: row.customerIdType, idNumber: row.customerIdNumber, name: row.customerName },
    subtotal: money(row.subtotal),
    totalDiscount: money(row.totalDiscount),
    taxes: parts.taxes,
    totalTax: money(row.totalTax),
    total: money(row.total),
    lines: parts.lines,
    payments: parts.payments,
    authorizationNumber: row.authorizationNumber,
    authorizedAt: row.authorizedAt,
    customerId: links.customerId,
    replacesDocumentId: links.replacesDocumentId,
    replacedByDocumentId: links.replacedByDocumentId,
    modifiedDocument:
      modified === null
        ? null
        : { code: modified.code, number: modified.number, issueDate: modified.issueDate, documentId: modified.documentId },
    reason: parts.reason,
    reasons: parts.reasons,
    creditedTotal: money(creditedTotal),
  };
}
