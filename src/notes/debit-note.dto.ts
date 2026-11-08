import {
  JsonList,
  JsonLocalDate,
  JsonObject,
  JsonString,
  JsonUuid,
  NoControlChars,
  NotBlank,
  NotNull,
  NotNullElements,
  Pattern,
  Size,
  Valid,
} from '../common/bean-validation.js';
import { BigDecimal } from '../common/big-decimal.js';
import { AMOUNT } from '../common/decimals.js';
import { strip } from '../common/java-text.js';
import { paymentCommand } from '../billing/invoice.service.js';
import { ModifiedDocumentDto, modifiedDocumentView } from './credit-note.dto.js';
import type { IssueDebitNoteCommand } from './debit-note.service.js';

/*
 * Cuerpo de POST /debit-notes: los records IssueDebitNoteRequest, ReasonRequest y PaymentRequest de
 * notes/DebitNoteController.java, con las coerciones de Jackson y las restricciones de Bean Validation.
 * ModifiedDocumentRequest es el de la nota de crédito.
 */

export class ReasonDto {
  @JsonString()
  @NotBlank()
  @Size({ max: 300 })
  @NoControlChars()
  reason!: string;

  @JsonString()
  @NotNull()
  @Pattern(AMOUNT)
  value!: string;

  @JsonString()
  @NotNull()
  @Pattern('[0-9]{1,4}')
  ivaRateCode!: string;
}

/** term y timeUnit: plazo y su unidad ("30" y "dias"), juntos o ninguno. */
export class DebitPaymentDto {
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

export class IssueDebitNoteDto {
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

  @JsonLocalDate()
  issueDate?: string | null;

  @JsonUuid()
  invoiceId?: string | null;

  @JsonObject(() => ModifiedDocumentDto)
  @Valid()
  modifiedDocument?: ModifiedDocumentDto | null;

  @JsonUuid()
  customerId?: string | null;

  @JsonList(() => ReasonDto)
  @NotNull()
  @Size({ min: 1, max: 20 })
  @NotNullElements()
  @Valid()
  reasons!: ReasonDto[];

  @JsonList(() => DebitPaymentDto)
  @NotNull()
  @Size({ min: 1, max: 1 })
  @NotNullElements()
  @Valid()
  payments!: DebitPaymentDto[];
}

/**
 * Lo que serializa Jackson en InvoiceController.requestHash para la nota de débito: los componentes de los
 * records en su orden, con los null, el texto recibido de cada importe y la razón sin recortar.
 */
export function debitNoteRequestView(dto: IssueDebitNoteDto): object {
  return {
    taxpayerId: dto.taxpayerId,
    establishmentCode: dto.establishmentCode,
    emissionPointCode: dto.emissionPointCode,
    issueDate: dto.issueDate ?? null,
    invoiceId: dto.invoiceId ?? null,
    modifiedDocument: modifiedDocumentView(dto.modifiedDocument),
    customerId: dto.customerId ?? null,
    reasons: dto.reasons.map((reason) => ({
      reason: reason.reason,
      value: reason.value,
      ivaRateCode: reason.ivaRateCode,
    })),
    payments: dto.payments.map((payment) => ({
      methodCode: payment.methodCode,
      amount: payment.amount,
      term: payment.term ?? null,
      timeUnit: payment.timeUnit ?? null,
    })),
  };
}

/** IssueDebitNoteRequest.toCommand de Java: razones recortadas, importes como BigDecimal y el único pago. */
export function debitNoteCommand(dto: IssueDebitNoteDto): IssueDebitNoteCommand {
  const modified = dto.modifiedDocument ?? null;
  const payment = dto.payments[0]!;
  return {
    taxpayerId: dto.taxpayerId,
    establishmentCode: dto.establishmentCode,
    emissionPointCode: dto.emissionPointCode,
    issueDate: dto.issueDate ?? null,
    invoiceId: dto.invoiceId ?? null,
    writtenInvoice: modified === null ? null : { number: modified.number, issueDate: modified.issueDate },
    customerId: dto.customerId ?? null,
    reasons: dto.reasons.map((reason) => ({
      reason: strip(reason.reason),
      value: BigDecimal.parse(reason.value, 12, 2),
      ivaRateCode: reason.ivaRateCode,
    })),
    payment: paymentCommand(
      payment.methodCode,
      BigDecimal.parse(payment.amount, 12, 2),
      payment.term === null || payment.term === undefined ? null : BigDecimal.parse(payment.term, 12, 2),
      payment.timeUnit ?? null,
    ),
  };
}
