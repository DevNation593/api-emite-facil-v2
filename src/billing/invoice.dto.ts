import {
  JsonList,
  JsonLocalDate,
  JsonString,
  JsonUuid,
  NoControlChars,
  NotNull,
  NotNullElements,
  Pattern,
  Size,
  Valid,
} from '../common/bean-validation.js';
import { BigDecimal } from '../common/big-decimal.js';
import { AMOUNT, QUANTITY_OR_PRICE } from '../common/decimals.js';
import { type IssueInvoiceCommand, paymentCommand } from './invoice.service.js';

/*
 * Cuerpo de POST /invoices: los records IssueInvoiceRequest, LineRequest y PaymentRequest de
 * billing/InvoiceController.java, con las mismas coerciones de Jackson y restricciones de Bean
 * Validation. Importes y cantidades llegan como texto (un número JSON, con el texto con que se
 * escribió) y se validan antes de convertirse.
 */

export class LineDto {
  @JsonUuid()
  @NotNull()
  productId!: string;

  @JsonString()
  @NotNull()
  @Pattern(QUANTITY_OR_PRICE)
  quantity!: string;

  @JsonString()
  @Pattern(QUANTITY_OR_PRICE)
  unitPrice?: string | null;

  @JsonString()
  @Pattern(AMOUNT)
  discount?: string | null;
}

/** term y timeUnit: plazo y su unidad («30» y «dias»), juntos o ninguno. */
export class PaymentDto {
  @JsonString()
  @NotNull()
  @Pattern('[0-9]{2}')
  methodCode!: string;

  @JsonString()
  @NotNull()
  @Pattern(AMOUNT)
  amount!: string;

  @JsonString()
  @Pattern(AMOUNT)
  term?: string | null;

  @JsonString()
  @Size({ max: 10 })
  @NoControlChars()
  timeUnit?: string | null;
}

export class IssueInvoiceDto {
  @JsonUuid()
  @NotNull()
  taxpayerId!: string;

  @JsonString()
  @NotNull()
  @Pattern('[0-9]{3}')
  establishmentCode!: string;

  @JsonString()
  @NotNull()
  @Pattern('[0-9]{3}')
  emissionPointCode!: string;

  @JsonUuid()
  @NotNull()
  customerId!: string;

  @JsonLocalDate()
  issueDate?: string | null;

  @JsonString()
  @Pattern('[A-Z]{3}')
  currency?: string | null;

  @JsonList(() => LineDto)
  @NotNull()
  @Size({ min: 1, max: 500 })
  @NotNullElements()
  @Valid()
  lines!: LineDto[];

  @JsonList(() => PaymentDto)
  @NotNull()
  @Size({ min: 1, max: 20 })
  @NotNullElements()
  @Valid()
  payments!: PaymentDto[];

  /** Se lee y entra en la huella; la reemisión aún no se atiende (llega con la Task 9). */
  @JsonUuid()
  replacesDocumentId?: string | null;
}

/**
 * Lo que serializa Jackson en InvoiceController.requestHash: las propiedades de los records en su orden,
 * con los null y con el texto recibido de cada importe.
 */
export function invoiceRequestView(dto: IssueInvoiceDto): object {
  return {
    taxpayerId: dto.taxpayerId,
    establishmentCode: dto.establishmentCode,
    emissionPointCode: dto.emissionPointCode,
    customerId: dto.customerId,
    issueDate: dto.issueDate ?? null,
    currency: dto.currency ?? null,
    lines: dto.lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      unitPrice: line.unitPrice ?? null,
      discount: line.discount ?? null,
    })),
    payments: dto.payments.map((payment) => ({
      methodCode: payment.methodCode,
      amount: payment.amount,
      term: payment.term ?? null,
      timeUnit: payment.timeUnit ?? null,
    })),
    replacesDocumentId: dto.replacesDocumentId ?? null,
  };
}

const parse = (value: string, integerDigits: number, fractionDigits: number) =>
  BigDecimal.parse(value, integerDigits, fractionDigits);
const parseOrNull = (value: string | null | undefined, integerDigits: number, fractionDigits: number) =>
  value === null || value === undefined ? null : parse(value, integerDigits, fractionDigits);

/** PaymentRequest.toCommand de Java. */
export function paymentRequestCommand(payment: PaymentDto) {
  return paymentCommand(
    payment.methodCode,
    parse(payment.amount, 12, 2),
    parseOrNull(payment.term, 12, 2),
    payment.timeUnit ?? null,
  );
}

/** IssueInvoiceRequest.toCommand de Java. */
export function invoiceCommand(dto: IssueInvoiceDto): IssueInvoiceCommand {
  return {
    taxpayerId: dto.taxpayerId,
    establishmentCode: dto.establishmentCode,
    emissionPointCode: dto.emissionPointCode,
    customerId: dto.customerId,
    issueDate: dto.issueDate ?? null,
    currency: dto.currency ?? null,
    lines: dto.lines.map((line) => ({
      productId: line.productId,
      quantity: parse(line.quantity, 12, 6),
      unitPrice: parseOrNull(line.unitPrice, 12, 6),
      discount: parseOrNull(line.discount, 12, 2),
    })),
    payments: dto.payments.map(paymentRequestCommand),
    replacesDocumentId: dto.replacesDocumentId ?? null,
  };
}
