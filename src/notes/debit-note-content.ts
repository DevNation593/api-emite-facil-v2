/**
 * Contenido congelado de una nota de débito y su XML en la versión 1.0.0 (notes/DebitNoteContent.java y
 * notes/DebitNoteXmlBuilder.java): los motivos con su valor e IVA, los impuestos agrupados por tarifa y el
 * pago. Lo demás (emisor, receptor, totales, factura modificada) va en el sobre.
 */
import type { BigDecimal } from '../common/big-decimal.js';
import {
  requireAmount,
  requireModified,
  requireTotals,
  type DocumentEnvelope,
} from '../billing/document-envelope.js';
import {
  contentCodec,
  list,
  type ContentShape,
} from '../billing/json-content.js';
import { DOCUMENT_SCHEMAS } from '../xml/document-type.js';
import { XmlWriter } from '../xml/xml-writer.js';
import type { DebitReason, NoteTax } from './debit-note-calculator.js';
import { NOTE_TAX_SHAPE } from './note-tax-shape.js';

export const DEBIT_NOTE_SCHEMA = DOCUMENT_SCHEMAS.DEBIT_NOTE_1_0_0;

/** `term` y `timeUnit` (plazo y unidadTiempo) son nulos si no se indicaron, también en las notas anteriores. */
export interface NotePayment {
  methodCode: string;
  amount: BigDecimal;
  term: BigDecimal | null;
  timeUnit: string | null;
}

export interface DebitNoteContent {
  reasons: DebitReason[];
  taxes: NoteTax[];
  payments: NotePayment[];
}

const DEBIT_REASON_SHAPE: ContentShape = [
  ['reason', 'string'],
  ['value', 'decimal'],
  ['taxCode', 'string'],
  ['taxRateCode', 'string'],
  ['taxRate', 'decimal'],
  ['taxAmount', 'decimal'],
];

const NOTE_PAYMENT_SHAPE: ContentShape = [
  ['methodCode', 'string'],
  ['amount', 'decimal'],
  ['term', 'decimal'],
  ['timeUnit', 'string'],
];

export const DEBIT_NOTE_CODEC = contentCodec<DebitNoteContent>([
  ['reasons', list(DEBIT_REASON_SHAPE)],
  ['taxes', list(NOTE_TAX_SHAPE)],
  ['payments', list(NOTE_PAYMENT_SHAPE)],
]);

export function buildDebitNoteXml(
  envelope: DocumentEnvelope,
  content: DebitNoteContent,
): Buffer {
  const issuer = envelope.issuer;
  const recipient = envelope.recipient;
  const totals = requireTotals(envelope);
  const modified = requireModified(envelope);

  const w = new XmlWriter();
  w.openRoot('notaDebito', DEBIT_NOTE_SCHEMA.version);
  w.infoTributaria({
    environment: envelope.environment,
    legalName: issuer.legalName,
    tradeName: issuer.tradeName,
    ruc: issuer.ruc,
    accessKey: envelope.accessKey,
    documentCode: envelope.type.code,
    establishmentCode: envelope.establishmentCode,
    emissionPointCode: envelope.emissionPointCode,
    sequence: envelope.sequence,
    headOfficeAddress: issuer.headOfficeAddress,
    withholdingAgentCode: issuer.withholdingAgentCode,
    rimpeRegime: issuer.rimpeRegime,
  });

  w.open('infoNotaDebito');
  w.date('fechaEmision', envelope.issueDate);
  w.optional('dirEstablecimiento', issuer.establishmentAddress);
  w.element('tipoIdentificacionComprador', recipient.idType);
  w.element('razonSocialComprador', recipient.name);
  w.element('identificacionComprador', recipient.idNumber);
  w.optional('contribuyenteEspecial', issuer.specialTaxpayerCode);
  w.element('obligadoContabilidad', issuer.accountingRequired ? 'SI' : 'NO');
  w.element('codDocModificado', modified.code);
  w.element('numDocModificado', modified.number);
  w.date('fechaEmisionDocSustento', modified.issueDate);
  w.money('totalSinImpuestos', requireAmount(totals.subtotal, 'subtotal'));
  w.open('impuestos');
  for (const tax of content.taxes) {
    w.open('impuesto');
    w.element('codigo', tax.taxCode);
    w.element('codigoPorcentaje', tax.rateCode);
    w.money('tarifa', tax.rate);
    w.money('baseImponible', tax.base);
    w.money('valor', tax.amount);
    w.close('impuesto');
  }
  w.close('impuestos');
  w.money('valorTotal', totals.total);
  w.open('pagos');
  for (const payment of content.payments) {
    w.open('pago');
    w.element('formaPago', payment.methodCode);
    w.money('total', payment.amount);
    if (payment.term !== null) {
      w.money('plazo', payment.term);
      w.element('unidadTiempo', payment.timeUnit as string);
    }
    w.close('pago');
  }
  w.close('pagos');
  w.close('infoNotaDebito');

  w.open('motivos');
  for (const reason of content.reasons) {
    w.open('motivo');
    w.element('razon', reason.reason);
    w.money('valor', reason.value);
    w.close('motivo');
  }
  w.close('motivos');

  w.providerInfo(envelope.providerRuc);
  w.close('notaDebito');
  return w.toBuffer();
}
