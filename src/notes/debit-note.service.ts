import type { Transaction } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { BigDecimal } from '../common/big-decimal.js';
import type { ErrorCode } from '../common/error-codes.js';
import type { CatalogRepository } from '../catalog/catalog.repository.js';
import type { CustomerService } from '../catalog/customer.service.js';
import type { DB } from '../database/schema.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';
import { type CatalogLines, requireStorable } from '../billing/catalog-lines.js';
import type { ModifiedDocument, Recipient } from '../billing/document-envelope.js';
import { type DocumentIssuer, type IssueRequest, type Preparation, recipientOf } from '../billing/document-issuer.js';
import type { FinalConsumerLimit } from '../billing/final-consumer-limit.js';
import { InvalidLineError } from '../billing/invoice-calculator.js';
import { type PaymentCommand, requireCompleteTerm } from '../billing/invoice.service.js';
import { calculateDebitNote, type DebitInput, type DebitNoteTotals } from './debit-note-calculator.js';
import type { DebitNoteContent } from './debit-note-content.js';
import type { DebitNoteKind } from './debit-note-kind.js';
import {
  modifiedDocumentOf,
  type ModifiedInvoices,
  requireNotLater,
  requireOneModifiedDocument,
  type WrittenInvoice,
  writtenModifiedDocument,
} from './modified-invoices.js';

/** Un motivo pedido: su razón (ya recortada), su valor sin IVA y el código de la tarifa de IVA del catálogo. */
export interface ReasonCommand {
  reason: string;
  value: BigDecimal;
  ivaRateCode: string;
}

/** `issueDate` nulo es hoy; invoiceId, o writtenInvoice con customerId. Exactamente un pago. */
export interface IssueDebitNoteCommand {
  taxpayerId: string;
  establishmentCode: string;
  emissionPointCode: string;
  issueDate: string | null;
  invoiceId: string | null;
  writtenInvoice: WrittenInvoice | null;
  customerId: string | null;
  reasons: ReasonCommand[];
  payment: PaymentCommand;
}

const unprocessable = (errorCode: ErrorCode, detail: string) => new ApiException(422, errorCode, detail);

/**
 * Lo propio de la nota de débito en la emisión (notes/DebitNoteService.java): motivos con su IVA, un pago
 * por el total y el límite de consumidor final. Sobre una factura de la plataforma toma su comprador; sobre
 * una escrita a mano, el cliente indicado. No hay saldo ni líneas de la factura. Lo común lo hace
 * DocumentIssuer, en la misma transacción.
 */
export class DebitNoteService {
  constructor(
    private readonly issuer: DocumentIssuer,
    private readonly kind: DebitNoteKind,
    private readonly invoices: ModifiedInvoices,
    private readonly customers: CustomerService,
    private readonly catalogLines: CatalogLines,
    private readonly catalogs: CatalogRepository,
    private readonly finalConsumerLimit: FinalConsumerLimit,
  ) {}

  /**
   * Emite la nota, o devuelve la ya emitida si la clave de idempotencia se repite con la misma petición.
   * Si algo falla, la transacción se revierte: ni nota ni secuencial.
   */
  issue(
    access: TenantAccess,
    idempotencyKey: string,
    requestHash: string,
    command: IssueDebitNoteCommand,
  ): Promise<string> {
    requireOneModifiedDocument(command.invoiceId, command.writtenInvoice, command.customerId);
    const request: IssueRequest = {
      taxpayerId: command.taxpayerId,
      establishmentCode: command.establishmentCode,
      emissionPointCode: command.emissionPointCode,
      issueDate: command.issueDate,
      currency: null,
      replacesDocumentId: null,
    };
    return this.issuer.issue(access, idempotencyKey, requestHash, request, (trx, context) =>
      this.prepare(trx, access, command, context.issueDate),
    );
  }

  /** Corre antes de reservar el secuencial; con factura de la plataforma, con ella bloqueada. */
  private async prepare(
    trx: Transaction<DB>,
    access: TenantAccess,
    command: IssueDebitNoteCommand,
    issueDate: string,
  ): Promise<Preparation<DebitNoteContent>> {
    let customerId: string;
    let buyer: Recipient;
    let modified: ModifiedDocument;
    if (command.invoiceId !== null) {
      const invoice = await this.invoices.lockForNote(trx, access, command.invoiceId, command.taxpayerId);
      requireNotLater(invoice.issueDate, issueDate);
      customerId = invoice.customerId;
      buyer = invoice.buyer;
      modified = modifiedDocumentOf(invoice);
    } else {
      // requireOneModifiedDocument ya exigió la factura escrita y el cliente.
      const written = command.writtenInvoice!;
      requireNotLater(written.issueDate, issueDate);
      const customer = await this.customers.get(access, command.customerId!, trx);
      customerId = customer.id;
      buyer = recipientOf(customer);
      modified = writtenModifiedDocument(written);
    }

    const result = await this.calculate(trx, command.reasons);
    requireStorable(result.subtotal, result.total);
    const payment = command.payment;
    requireCompleteTerm(payment);
    if (!(await this.catalogs.paymentMethodValidOn(trx, payment.methodCode, issueDate))) {
      throw unprocessable('PAYMENT_METHOD_UNKNOWN', 'La forma de pago no existe o no está vigente en la fecha de emisión');
    }
    if (payment.amount.compareTo(result.total) !== 0) {
      throw unprocessable('PAYMENTS_MISMATCH', 'El pago no coincide con el total del comprobante');
    }
    await this.finalConsumerLimit.check(trx, buyer.idType, result.total);

    return {
      kind: this.kind,
      customerId,
      recipient: buyer,
      totals: {
        subtotal: result.subtotal,
        totalDiscount: BigDecimal.ZERO,
        totalTax: result.totalTax,
        total: result.total,
      },
      modified,
      content: {
        reasons: result.reasons,
        taxes: result.taxes,
        payments: [
          {
            methodCode: payment.methodCode,
            amount: payment.amount,
            term: payment.term,
            timeUnit: payment.timeUnit,
          },
        ],
      },
    };
  }

  /** Cada motivo con la tarifa del catálogo (422 TAX_RATE_UNKNOWN); un valor no positivo es 422 INVALID_LINE. */
  private async calculate(trx: Transaction<DB>, reasons: ReasonCommand[]): Promise<DebitNoteTotals> {
    const inputs: DebitInput[] = [];
    for (const reason of reasons) {
      inputs.push({
        reason: reason.reason,
        value: reason.value,
        ivaRateCode: reason.ivaRateCode,
        ivaRate: await this.catalogLines.ivaRate(trx, reason.ivaRateCode),
      });
    }
    try {
      return calculateDebitNote(inputs);
    } catch (error) {
      if (error instanceof InvalidLineError) throw unprocessable('INVALID_LINE', error.message);
      throw error;
    }
  }
}
