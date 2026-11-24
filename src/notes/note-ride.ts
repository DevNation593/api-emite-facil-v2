import { documentNumber, type DocumentEnvelope, requireModified, requireTotals } from '../billing/document-envelope.js';
import type { RideEnvelope } from '../billing/ride-envelope.js';
import { BigDecimal } from '../common/big-decimal.js';
import { localDateText } from '../common/java-time.js';
import { linesTable, requireAuthorization } from '../delivery/invoice-ride.js';
import { type PdfTable, renderDocument } from '../delivery/pdf-table.js';
import * as layout from '../delivery/ride-layout.js';
import type { CreditNoteContent } from './credit-note-content.js';
import type { DebitNoteContent } from './debit-note-content.js';

/*
 * RIDE de las notas autorizadas, como notes/CreditNoteRide.java, notes/DebitNoteRide.java y
 * notes/NoteRideSupport.java: la cabecera común, la factura que se modifica y el detalle y el pie de cada nota.
 */

export function buildCreditNoteRide(ride: RideEnvelope, content: CreditNoteContent): Promise<Buffer> {
  const totals = requireTotals(ride.envelope);
  const table = layout.totalsTable();
  layout.subtotalRows(table, content.taxes);
  layout.total(table, 'Descuento', totals.totalDiscount ?? BigDecimal.ZERO);
  layout.vatRows(table, content.taxes);
  layout.grandTotal(table, 'VALOR MODIFICACIÓN', totals.total);
  return build(
    ride,
    'NOTA DE CRÉDITO',
    content.reason,
    linesTable(content.lines),
    layout.footer(below(ride.envelope, null), table),
  );
}

export function buildDebitNoteRide(
  ride: RideEnvelope,
  content: DebitNoteContent,
  paymentMethodNames: ReadonlyMap<string, string>,
): Promise<Buffer> {
  const detail = layout.detailTable([80, 20], 'RAZÓN DE LA MODIFICACIÓN', 'VALOR');
  for (const reason of content.reasons) {
    detail.add(layout.text(reason.reason, 'left'));
    detail.add(layout.text(layout.amount(reason.value, 2), 'right'));
  }
  const payments = layout.paymentsTable();
  for (const payment of content.payments) {
    layout.payment(
      payments,
      payment.methodCode,
      paymentMethodNames.get(payment.methodCode),
      payment.amount,
      payment.term,
      payment.timeUnit,
    );
  }
  const table = layout.totalsTable();
  layout.subtotalRows(table, content.taxes);
  layout.vatRows(table, content.taxes);
  layout.grandTotal(table, 'TOTAL', requireTotals(ride.envelope).total);
  return build(ride, 'NOTA DE DÉBITO', null, detail, layout.footer(below(ride.envelope, payments), table));
}

/** `title` va en mayúsculas en el RIDE; `reason` es nulo en la nota de débito. */
async function build(
  ride: RideEnvelope,
  title: string,
  reason: string | null,
  detail: PdfTable,
  footer: PdfTable,
): Promise<Buffer> {
  const { envelope } = ride;
  const { authorizationNumber, authorizedAt } = requireAuthorization(ride.authorizationNumber, ride.authorizedAt);
  const number = documentNumber(envelope);
  return renderDocument(`${title} ${number}`, [
    layout.header(
      envelope.issuer,
      title,
      number,
      envelope.environment,
      envelope.accessKey,
      authorizationNumber,
      authorizedAt,
    ),
    layout.SPACER,
    layout.recipientTable(envelope.recipient, envelope.issueDate),
    layout.SPACER,
    modifiedDocument(envelope, reason),
    layout.SPACER,
    detail,
    layout.SPACER,
    footer,
  ]);
}

function modifiedDocument(envelope: DocumentEnvelope, reason: string | null): PdfTable {
  const modified = requireModified(envelope);
  const rows: Array<[string, string]> = [
    ['Comprobante:', `FACTURA ${modified.number}`],
    ['Fecha de emisión:', localDateText(modified.issueDate)],
  ];
  if (reason !== null) rows.push(['Razón de modificación:', reason]);
  return layout.infoTable('COMPROBANTE MODIFICADO', rows);
}

/** Bloques bajo los totales: la información adicional del receptor y, debajo, `payments` (puede ser nulo). */
function below(envelope: DocumentEnvelope, payments: PdfTable | null): PdfTable {
  const { recipient } = envelope;
  const box = layout.box();
  box.add(
    layout.wrap(layout.additionalInfo(recipient.email, recipient.address, recipient.phone, envelope.providerRuc)),
  );
  if (payments !== null) {
    box.add(layout.gap());
    box.add(layout.wrap(payments));
  }
  return box;
}
