import {
  JsonInteger,
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
import { AMOUNT, QUANTITY_OR_PRICE } from '../common/decimals.js';
import { strip } from '../common/java-text.js';
import type { IssueCreditNoteCommand } from './credit-note.service.js';

/*
 * Cuerpo de POST /credit-notes: los records IssueCreditNoteRequest, ModifiedDocumentRequest y
 * CreditLineRequest de notes/CreditNoteController.java, con las coerciones de Jackson y las
 * restricciones de Bean Validation. ModifiedDocumentDto lo reutiliza la nota de débito.
 */

/** La factura escrita a mano que modifica la nota: siempre una factura (código 01). */
export class ModifiedDocumentDto {
  @JsonString()
  @NotNull()
  @Pattern('01')
  code!: string;

  @JsonString()
  @NotNull()
  @Pattern('[0-9]{3}-[0-9]{3}-[0-9]{9}')
  number!: string;

  @JsonLocalDate()
  @NotNull()
  issueDate!: string;
}

export class CreditLineDto {
  @JsonInteger()
  invoiceLineNo?: number | null;

  @JsonUuid()
  productId?: string | null;

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

export class IssueCreditNoteDto {
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

  @JsonString()
  @NotBlank()
  @Size({ max: 300 })
  @NoControlChars()
  reason!: string;

  @JsonUuid()
  invoiceId?: string | null;

  @JsonObject(() => ModifiedDocumentDto)
  @Valid()
  modifiedDocument?: ModifiedDocumentDto | null;

  @JsonUuid()
  customerId?: string | null;

  @JsonList(() => CreditLineDto)
  @NotNull()
  @Size({ min: 1, max: 200 })
  @NotNullElements()
  @Valid()
  lines!: CreditLineDto[];
}

/** Lo que Jackson escribe de ModifiedDocumentRequest: code, number e issueDate, en ese orden. */
export function modifiedDocumentView(dto: ModifiedDocumentDto | null | undefined): object | null {
  return dto === null || dto === undefined ? null : { code: dto.code, number: dto.number, issueDate: dto.issueDate };
}

/**
 * Lo que serializa Jackson en InvoiceController.requestHash para la nota de crédito: los componentes de
 * los records en su orden, con los null, el texto recibido de cada importe y el motivo sin recortar.
 */
export function creditNoteRequestView(dto: IssueCreditNoteDto): object {
  return {
    taxpayerId: dto.taxpayerId,
    establishmentCode: dto.establishmentCode,
    emissionPointCode: dto.emissionPointCode,
    issueDate: dto.issueDate ?? null,
    reason: dto.reason,
    invoiceId: dto.invoiceId ?? null,
    modifiedDocument: modifiedDocumentView(dto.modifiedDocument),
    customerId: dto.customerId ?? null,
    lines: dto.lines.map((line) => ({
      invoiceLineNo: line.invoiceLineNo ?? null,
      productId: line.productId ?? null,
      quantity: line.quantity,
      unitPrice: line.unitPrice ?? null,
      discount: line.discount ?? null,
    })),
  };
}

const parseOrNull = (value: string | null | undefined, integerDigits: number, fractionDigits: number) =>
  value === null || value === undefined ? null : BigDecimal.parse(value, integerDigits, fractionDigits);

/** IssueCreditNoteRequest.toCommand de Java: el motivo recortado y los importes como BigDecimal. */
export function creditNoteCommand(dto: IssueCreditNoteDto): IssueCreditNoteCommand {
  const modified = dto.modifiedDocument ?? null;
  return {
    taxpayerId: dto.taxpayerId,
    establishmentCode: dto.establishmentCode,
    emissionPointCode: dto.emissionPointCode,
    issueDate: dto.issueDate ?? null,
    reason: strip(dto.reason),
    invoiceId: dto.invoiceId ?? null,
    writtenInvoice: modified === null ? null : { number: modified.number, issueDate: modified.issueDate },
    customerId: dto.customerId ?? null,
    lines: dto.lines.map((line) => ({
      invoiceLineNo: line.invoiceLineNo ?? null,
      productId: line.productId ?? null,
      quantity: BigDecimal.parse(line.quantity, 12, 6),
      unitPrice: parseOrNull(line.unitPrice, 12, 6),
      discount: parseOrNull(line.discount, 12, 2),
    })),
  };
}
