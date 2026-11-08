/**
 * Contenido congelado de una nota de crédito y su XML en la versión 1.1.0 (notes/CreditNoteContent.java y
 * notes/CreditNoteXmlBuilder.java): el motivo, las líneas devueltas y los impuestos agrupados. Lo demás
 * (emisor, receptor, totales, factura modificada) va en el sobre del documento.
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
import { CURRENCY, XmlWriter } from '../xml/xml-writer.js';
import type { NoteTax } from './debit-note-calculator.js';
import { NOTE_TAX_SHAPE } from './note-tax-shape.js';

export const CREDIT_NOTE_SCHEMA = DOCUMENT_SCHEMAS.CREDIT_NOTE_1_1_0;

/** `invoiceLineNo` y `productId` son nulos cuando la línea no viene de una factura de la plataforma. */
export interface CreditNoteLine {
  invoiceLineNo: number | null;
  productId: string | null;
  mainCode: string;
  description: string;
  quantity: BigDecimal;
  unitPrice: BigDecimal;
  discount: BigDecimal;
  subtotal: BigDecimal;
  taxCode: string;
  taxRateCode: string;
  taxRate: BigDecimal;
  taxAmount: BigDecimal;
}

export interface CreditNoteContent {
  reason: string;
  lines: CreditNoteLine[];
  taxes: NoteTax[];
}

const CREDIT_NOTE_LINE_SHAPE: ContentShape = [
  ['invoiceLineNo', 'integer'],
  ['productId', 'uuid'],
  ['mainCode', 'string'],
  ['description', 'string'],
  ['quantity', 'decimal'],
  ['unitPrice', 'decimal'],
  ['discount', 'decimal'],
  ['subtotal', 'decimal'],
  ['taxCode', 'string'],
  ['taxRateCode', 'string'],
  ['taxRate', 'decimal'],
  ['taxAmount', 'decimal'],
];

export const CREDIT_NOTE_CODEC = contentCodec<CreditNoteContent>([
  ['reason', 'string'],
  ['lines', list(CREDIT_NOTE_LINE_SHAPE)],
  ['taxes', list(NOTE_TAX_SHAPE)],
]);

export function buildCreditNoteXml(
  envelope: DocumentEnvelope,
  content: CreditNoteContent,
): Buffer {
  const issuer = envelope.issuer;
  const recipient = envelope.recipient;
  const totals = requireTotals(envelope);
  const modified = requireModified(envelope);

  const w = new XmlWriter();
  w.openRoot('notaCredito', CREDIT_NOTE_SCHEMA.version);
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

  w.open('infoNotaCredito');
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
  w.money('valorModificacion', totals.total);
  w.element('moneda', CURRENCY);
  w.open('totalConImpuestos');
  for (const tax of content.taxes) {
    w.open('totalImpuesto');
    w.element('codigo', tax.taxCode);
    w.element('codigoPorcentaje', tax.rateCode);
    w.money('baseImponible', tax.base);
    w.money('valor', tax.amount);
    w.close('totalImpuesto');
  }
  w.close('totalConImpuestos');
  w.element('motivo', content.reason);
  w.close('infoNotaCredito');

  w.open('detalles');
  for (const line of content.lines) {
    w.open('detalle');
    w.element('codigoInterno', line.mainCode);
    w.element('descripcion', line.description);
    w.scaled('cantidad', line.quantity, 6);
    w.scaled('precioUnitario', line.unitPrice, 6);
    w.money('descuento', line.discount);
    w.money('precioTotalSinImpuesto', line.subtotal);
    w.open('impuestos');
    w.open('impuesto');
    w.element('codigo', line.taxCode);
    w.element('codigoPorcentaje', line.taxRateCode);
    w.money('tarifa', line.taxRate);
    w.money('baseImponible', line.subtotal);
    w.money('valor', line.taxAmount);
    w.close('impuesto');
    w.close('impuestos');
    w.close('detalle');
  }
  w.close('detalles');

  w.providerInfo(envelope.providerRuc);
  w.close('notaCredito');
  return w.toBuffer();
}
