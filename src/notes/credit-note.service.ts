import type { Transaction } from 'kysely';
import { ApiException, type FieldError } from '../common/api-exception.js';
import type { BigDecimal } from '../common/big-decimal.js';
import type { ErrorCode } from '../common/error-codes.js';
import { IVA_TAX_CODE } from '../catalog/catalog.repository.js';
import type { CustomerService } from '../catalog/customer.service.js';
import type { DB } from '../database/schema.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';
import { calculateStorable, type CatalogLines } from '../billing/catalog-lines.js';
import type { ModifiedDocument, Recipient } from '../billing/document-envelope.js';
import { type DocumentIssuer, type IssueRequest, type Preparation, recipientOf } from '../billing/document-issuer.js';
import type { FiscalDocumentRepository, LineRow } from '../billing/fiscal-document.repository.js';
import type { InvoiceLineInput, InvoiceTotals, LineAmounts } from '../billing/invoice-calculator.js';
import type { CreditNoteContent, CreditNoteLine } from './credit-note-content.js';
import type { CreditNoteKind } from './credit-note-kind.js';
import {
  invoiceLine,
  modifiedDocumentOf,
  type ModifiedInvoices,
  requireNotLater,
  requireOneModifiedDocument,
  type WrittenInvoice,
  writtenModifiedDocument,
} from './modified-invoices.js';
import { proratedDiscount } from './prorated-discount.js';

/**
 * Una línea pedida: con factura de la plataforma, invoiceLineNo y sin productId; a mano, productId y sin
 * invoiceLineNo. Precio nulo toma el de la línea original y descuento nulo, el original en proporción a
 * la cantidad (a mano, el precio del producto y cero).
 */
export interface CreditLineCommand {
  invoiceLineNo: number | null;
  productId: string | null;
  quantity: BigDecimal;
  unitPrice: BigDecimal | null;
  discount: BigDecimal | null;
}

/** `issueDate` nulo es hoy; invoiceId, o writtenInvoice con customerId. `reason` ya va recortado. */
export interface IssueCreditNoteCommand {
  taxpayerId: string;
  establishmentCode: string;
  emissionPointCode: string;
  issueDate: string | null;
  reason: string;
  invoiceId: string | null;
  writtenInvoice: WrittenInvoice | null;
  customerId: string | null;
  lines: CreditLineCommand[];
}

const unprocessable = (errorCode: ErrorCode, detail: string) => new ApiException(422, errorCode, detail);

/** `BigDecimal.toPlainString()` de Java. */
const plain = (value: BigDecimal) => value.toFixed(value.scale);

/**
 * 400 VALIDATION_FAILED si una línea no tiene la forma de su caso: con factura de la plataforma,
 * invoiceLineNo sin productId y sin repetir la línea; a mano, productId sin invoiceLineNo.
 */
function requireLineShape(command: IssueCreditNoteCommand): void {
  const fromInvoice = command.invoiceId !== null;
  const errors: FieldError[] = [];
  const invoiceLines = new Set<number>();
  command.lines.forEach((line, i) => {
    const field = `lines[${i}]`;
    if (fromInvoice && (line.invoiceLineNo === null || line.productId !== null)) {
      errors.push({ field, message: 'Con invoiceId, la línea lleva invoiceLineNo y no productId' });
    } else if (fromInvoice && invoiceLines.has(line.invoiceLineNo!)) {
      errors.push({ field: `${field}.invoiceLineNo`, message: 'La línea de la factura se repite' });
    } else if (fromInvoice) {
      invoiceLines.add(line.invoiceLineNo!);
    } else if (line.productId === null || line.invoiceLineNo !== null) {
      errors.push({ field, message: 'Sin invoiceId, la línea lleva productId y no invoiceLineNo' });
    }
  });
  if (errors.length > 0) {
    throw new ApiException(400, 'VALIDATION_FAILED', 'La petición no cumple las reglas de validación', errors);
  }
}

function creditLine(
  invoiceLineNo: number | null,
  productId: string | null,
  mainCode: string,
  description: string,
  taxCode: string,
  input: InvoiceLineInput,
  amounts: LineAmounts,
): CreditNoteLine {
  return {
    invoiceLineNo,
    productId,
    mainCode,
    description,
    quantity: input.quantity,
    unitPrice: input.unitPrice,
    discount: input.discount,
    subtotal: amounts.subtotal,
    taxCode,
    taxRateCode: input.ivaRateCode,
    taxRate: input.ivaRate,
    taxAmount: amounts.taxAmount,
  };
}

/**
 * Lo propio de la nota de crédito en la emisión (notes/CreditNoteService.java). Sobre una factura de la
 * plataforma: la bloquea, copia sus líneas (que solo bajan) y su comprador, y cuida que las notas
 * vigentes no superen su total. Sobre una factura escrita a mano: líneas del catálogo y el cliente
 * indicado, como en la factura. El cálculo es el de la factura. Lo común lo hace DocumentIssuer, en la
 * misma transacción.
 */
export class CreditNoteService {
  constructor(
    private readonly issuer: DocumentIssuer,
    private readonly kind: CreditNoteKind,
    private readonly invoices: ModifiedInvoices,
    private readonly documents: FiscalDocumentRepository,
    private readonly customers: CustomerService,
    private readonly catalogLines: CatalogLines,
  ) {}

  /**
   * Emite la nota, o devuelve la ya emitida si la clave de idempotencia se repite con la misma petición.
   * Si algo falla, la transacción se revierte: ni nota, ni secuencial, ni saldo consumido.
   */
  issue(
    access: TenantAccess,
    idempotencyKey: string,
    requestHash: string,
    command: IssueCreditNoteCommand,
  ): Promise<string> {
    requireOneModifiedDocument(command.invoiceId, command.writtenInvoice, command.customerId);
    requireLineShape(command);
    const request: IssueRequest = {
      taxpayerId: command.taxpayerId,
      establishmentCode: command.establishmentCode,
      emissionPointCode: command.emissionPointCode,
      issueDate: command.issueDate,
      currency: null,
      replacesDocumentId: null,
    };
    return this.issuer.issue(access, idempotencyKey, requestHash, request, (trx, context) =>
      command.invoiceId === null
        ? this.fromWrittenInvoice(trx, access, command, context.issueDate)
        : this.fromInvoice(trx, access, command, command.invoiceId, context.issueDate),
    );
  }

  /** Sobre una factura de la plataforma; corre antes de reservar el secuencial, con la factura bloqueada. */
  private async fromInvoice(
    trx: Transaction<DB>,
    access: TenantAccess,
    command: IssueCreditNoteCommand,
    invoiceId: string,
    issueDate: string,
  ): Promise<Preparation<CreditNoteContent>> {
    const invoice = await this.invoices.lockForNote(trx, access, invoiceId, command.taxpayerId);
    requireNotLater(invoice.issueDate, issueDate);
    const originals: LineRow[] = [];
    const inputs: InvoiceLineInput[] = [];
    for (const line of command.lines) {
      // requireLineShape ya exigió invoiceLineNo en cada línea.
      const lineNo = line.invoiceLineNo!;
      const original = invoiceLine(invoice, lineNo);
      if (original === null) throw unprocessable('CREDIT_LINE_UNKNOWN', `La factura no tiene la línea ${lineNo}`);
      const unitPrice = line.unitPrice ?? original.unitPrice;
      if (line.quantity.compareTo(original.quantity) > 0 || unitPrice.compareTo(original.unitPrice) > 0) {
        throw unprocessable(
          'CREDIT_LINE_EXCEEDS_INVOICE',
          `La línea ${lineNo} supera la cantidad o el precio unitario de la factura`,
        );
      }
      const minimumDiscount = proratedDiscount(original.discount, original.quantity, line.quantity);
      if (line.discount !== null && line.discount.compareTo(minimumDiscount) < 0) {
        throw unprocessable(
          'CREDIT_LINE_EXCEEDS_INVOICE',
          `La línea ${lineNo} no puede llevar un descuento menor que el de la factura en proporción a la ` +
            `cantidad: ${plain(minimumDiscount)}`,
        );
      }
      originals.push(original);
      inputs.push({
        quantity: line.quantity,
        unitPrice,
        discount: line.discount ?? minimumDiscount,
        ivaRateCode: original.taxRateCode,
        ivaRate: original.taxRate,
      });
    }
    const totals = calculateStorable(inputs);
    // Con la factura bloqueada, la suma ya incluye la nota que otra emisión acaba de confirmar.
    const credited = await this.documents.creditedTotal(trx, access.tenantId, invoice.id);
    if (credited.add(totals.total).compareTo(invoice.total) > 0) {
      throw unprocessable(
        'CREDIT_EXCEEDS_INVOICE',
        `Las notas de crédito de la factura superarían su total; saldo disponible: ${plain(invoice.total.subtract(credited))}`,
      );
    }
    const lines = inputs.map((input, i) => {
      const original = originals[i]!;
      return creditLine(
        original.lineNo,
        original.productId,
        original.mainCode,
        original.description,
        original.taxCode,
        input,
        totals.lines[i]!,
      );
    });
    return this.preparation(invoice.customerId, invoice.buyer, totals, modifiedDocumentOf(invoice), command.reason, lines);
  }

  /** Sobre una factura escrita a mano: el cliente y las líneas salen del catálogo, como en la factura. */
  private async fromWrittenInvoice(
    trx: Transaction<DB>,
    access: TenantAccess,
    command: IssueCreditNoteCommand,
    issueDate: string,
  ): Promise<Preparation<CreditNoteContent>> {
    // requireOneModifiedDocument ya exigió la factura escrita y el cliente.
    const written = command.writtenInvoice!;
    requireNotLater(written.issueDate, issueDate);
    const buyer = await this.customers.get(access, command.customerId!, trx);
    const resolved = await this.catalogLines.resolve(
      trx,
      access,
      command.lines.map((line) => ({
        // requireLineShape ya exigió productId en cada línea.
        productId: line.productId!,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount,
      })),
    );
    const totals = calculateStorable(resolved.map((line) => line.input));
    const lines = resolved.map(({ product, input }, i) =>
      creditLine(null, product.id, product.sku, product.name, IVA_TAX_CODE, input, totals.lines[i]!),
    );
    return this.preparation(buyer.id, recipientOf(buyer), totals, writtenModifiedDocument(written), command.reason, lines);
  }

  /** El total de la nota es su valorModificacion. */
  private preparation(
    customerId: string,
    buyer: Recipient,
    totals: InvoiceTotals,
    modified: ModifiedDocument,
    reason: string,
    lines: CreditNoteLine[],
  ): Preparation<CreditNoteContent> {
    return {
      kind: this.kind,
      customerId,
      recipient: buyer,
      totals: {
        subtotal: totals.subtotal,
        totalDiscount: totals.totalDiscount,
        totalTax: totals.totalTax,
        total: totals.total,
      },
      modified,
      content: { reason, lines, taxes: totals.taxes },
    };
  }
}
