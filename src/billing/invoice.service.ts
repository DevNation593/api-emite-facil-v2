import type { Transaction } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { BigDecimal } from '../common/big-decimal.js';
import type { ErrorCode } from '../common/error-codes.js';
import { strip } from '../common/java-text.js';
import { type CatalogRepository, IVA_TAX_CODE } from '../catalog/catalog.repository.js';
import type { CustomerService } from '../catalog/customer.service.js';
import type { DB } from '../database/schema.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';
import { calculateStorable, type CatalogLines, type LineCommand } from './catalog-lines.js';
import { type DocumentIssuer, type IssueRequest, type Preparation, recipientOf } from './document-issuer.js';
import type { FinalConsumerLimit } from './final-consumer-limit.js';
import type { NewLine, NewPayment } from './fiscal-document.repository.js';
import type { InvoiceBody, InvoiceKind } from './invoice-kind.js';

export type { LineCommand } from './catalog-lines.js';

/**
 * Una forma de pago con su plazo opcional: term y timeUnit (plazo y unidadTiempo del XML, como «30» y
 * «dias») van juntos o ninguno. Se crea con paymentCommand, que deja la unidad como Java.
 */
export interface PaymentCommand {
  methodCode: string;
  amount: BigDecimal;
  term: BigDecimal | null;
  timeUnit: string | null;
}

/** El constructor de PaymentCommand de Java: una unidad en blanco cuenta como ausente; si no, se recorta. */
export function paymentCommand(
  methodCode: string,
  amount: BigDecimal,
  term: BigDecimal | null,
  timeUnit: string | null,
): PaymentCommand {
  return {
    methodCode,
    amount,
    term,
    timeUnit: timeUnit === null || strip(timeUnit) === '' ? null : strip(timeUnit),
  };
}

const unprocessable = (errorCode: ErrorCode, detail: string) => new ApiException(422, errorCode, detail);

/** 422 INVALID_PAYMENT_TERM si llega el plazo sin su unidad o la unidad sin plazo. */
export function requireCompleteTerm(payment: PaymentCommand): void {
  if ((payment.term === null) !== (payment.timeUnit === null)) {
    throw unprocessable('INVALID_PAYMENT_TERM', 'El plazo de una forma de pago lleva su unidad de tiempo');
  }
}

/** `issueDate` es YYYY-MM-DD o nulo (hoy); `currency` y `replacesDocumentId` pueden ser nulos. */
export interface IssueInvoiceCommand {
  taxpayerId: string;
  establishmentCode: string;
  emissionPointCode: string;
  customerId: string;
  issueDate: string | null;
  currency: string | null;
  lines: LineCommand[];
  payments: PaymentCommand[];
  replacesDocumentId: string | null;
}

/**
 * Lo propio de la factura en la emisión (billing/InvoiceService.java): productos, cálculo, importes
 * máximos, pagos y límite de consumidor final. Lo común (idempotencia, reemisión, emisor, punto,
 * secuencial, XML, outbox) lo hace DocumentIssuer, en una sola transacción con esta parte.
 */
export class InvoiceService {
  constructor(
    private readonly issuer: DocumentIssuer,
    private readonly kind: InvoiceKind,
    private readonly customers: CustomerService,
    private readonly catalogLines: CatalogLines,
    private readonly catalogs: CatalogRepository,
    private readonly finalConsumerLimit: FinalConsumerLimit,
  ) {}

  /**
   * Emite la factura, o devuelve la ya emitida si la clave de idempotencia se repite con la misma
   * petición. Si la emisión falla, la transacción se revierte y la clave queda libre para reintentar.
   */
  issue(access: TenantAccess, idempotencyKey: string, requestHash: string, command: IssueInvoiceCommand): Promise<string> {
    const request: IssueRequest = {
      taxpayerId: command.taxpayerId,
      establishmentCode: command.establishmentCode,
      emissionPointCode: command.emissionPointCode,
      issueDate: command.issueDate,
      currency: command.currency,
      replacesDocumentId: command.replacesDocumentId,
    };
    return this.issuer.issue(access, idempotencyKey, requestHash, request, (trx, context) =>
      this.prepare(trx, access, command, context.issueDate),
    );
  }

  /** Valida y calcula la factura; corre dentro de la transacción de la emisión, antes de reservar el secuencial. */
  private async prepare(
    trx: Transaction<DB>,
    access: TenantAccess,
    command: IssueInvoiceCommand,
    issueDate: string,
  ): Promise<Preparation<InvoiceBody>> {
    const customer = await this.customers.get(access, command.customerId, trx);
    const resolved = await this.catalogLines.resolve(trx, access, command.lines);
    const totals = calculateStorable(resolved.map((line) => line.input));

    let paid = BigDecimal.ZERO;
    for (const payment of command.payments) {
      // Un pago en cero solo tiene sentido cuando el comprobante entero vale cero.
      if (payment.amount.signum() === 0 && totals.total.signum() !== 0) {
        throw unprocessable('INVALID_PAYMENT', 'Un pago no puede ser cero si el comprobante tiene valor');
      }
      if (!(await this.catalogs.paymentMethodValidOn(trx, payment.methodCode, issueDate))) {
        throw unprocessable(
          'PAYMENT_METHOD_UNKNOWN',
          'La forma de pago no existe o no está vigente en la fecha de emisión',
        );
      }
      requireCompleteTerm(payment);
      paid = paid.add(payment.amount);
    }
    if (paid.compareTo(totals.total) !== 0) {
      throw unprocessable('PAYMENTS_MISMATCH', 'La suma de los pagos no coincide con el total del comprobante');
    }
    await this.finalConsumerLimit.check(trx, customer.idType, totals.total);

    const lines = resolved.map(({ product, input }, i): NewLine => {
      const amounts = totals.lines[i]!;
      return {
        productId: product.id,
        mainCode: product.sku,
        description: product.name,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        discount: input.discount,
        subtotal: amounts.subtotal,
        taxCode: IVA_TAX_CODE,
        taxRateCode: input.ivaRateCode,
        taxRate: input.ivaRate,
        taxAmount: amounts.taxAmount,
      };
    });
    const payments = command.payments.map(
      (payment): NewPayment => ({
        methodCode: payment.methodCode,
        amount: payment.amount,
        term: payment.term,
        timeUnit: payment.timeUnit,
      }),
    );
    return {
      kind: this.kind,
      customerId: customer.id,
      recipient: recipientOf(customer),
      totals: {
        subtotal: totals.subtotal,
        totalDiscount: totals.totalDiscount,
        totalTax: totals.totalTax,
        total: totals.total,
      },
      modified: null,
      content: { lines, taxes: totals.taxes, payments },
    };
  }
}
