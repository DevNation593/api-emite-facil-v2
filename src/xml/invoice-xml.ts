/**
 * XML de una factura en la versión 1.1.0 (ficha técnica v2.34, Anexo 3), la que admite seis decimales
 * en cantidad y precio unitario (xml/InvoiceXmlBuilder.java y xml/InvoiceXmlData.java). El resultado
 * es determinista: los mismos datos producen los mismos bytes, sin espacios entre elementos.
 */
import { BigDecimal } from '../common/big-decimal.js';
import { DOCUMENT_SCHEMAS } from './document-type.js';
import { CURRENCY, XmlWriter } from './xml-writer.js';

export const INVOICE_SCHEMA = DOCUMENT_SCHEMAS.INVOICE_1_1_0;

export interface InvoiceXmlTax {
  taxCode: string;
  rateCode: string;
  rate: BigDecimal;
  base: BigDecimal;
  amount: BigDecimal;
}

export interface InvoiceXmlLine {
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

/** `term` y `timeUnit` (plazo y unidadTiempo) van juntos o ambos nulos. */
export interface InvoiceXmlPayment {
  methodCode: string;
  amount: BigDecimal;
  term: BigDecimal | null;
  timeUnit: string | null;
}

/**
 * Todo lo que el XML de una factura necesita, tal como quedó congelado al emitirse. `rimpeRegime` es
 * NONE, EMPRENDEDOR o NEGOCIO_POPULAR; `issueDate` es `YYYY-MM-DD`; los opcionales pueden ser nulos.
 */
export interface InvoiceXmlData {
  environment: string;
  issuerLegalName: string;
  issuerTradeName: string | null;
  issuerRuc: string;
  accessKey: string;
  documentType: string;
  establishmentCode: string;
  emissionPointCode: string;
  sequence: number;
  headOfficeAddress: string;
  withholdingAgentCode: string | null;
  rimpeRegime: string;
  issueDate: string;
  establishmentAddress: string | null;
  specialTaxpayerCode: string | null;
  accountingRequired: boolean;
  customerIdType: string;
  customerName: string;
  customerIdNumber: string;
  customerAddress: string | null;
  subtotal: BigDecimal;
  totalDiscount: BigDecimal;
  taxes: InvoiceXmlTax[];
  total: BigDecimal;
  lines: InvoiceXmlLine[];
  payments: InvoiceXmlPayment[];
  providerRuc: string | null;
}

export function buildInvoiceXml(d: InvoiceXmlData): Buffer {
  const w = new XmlWriter();
  w.openRoot('factura', INVOICE_SCHEMA.version);
  w.infoTributaria({
    environment: d.environment,
    legalName: d.issuerLegalName,
    tradeName: d.issuerTradeName,
    ruc: d.issuerRuc,
    accessKey: d.accessKey,
    documentCode: d.documentType,
    establishmentCode: d.establishmentCode,
    emissionPointCode: d.emissionPointCode,
    sequence: d.sequence,
    headOfficeAddress: d.headOfficeAddress,
    withholdingAgentCode: d.withholdingAgentCode,
    rimpeRegime: d.rimpeRegime,
  });

  w.open('infoFactura');
  w.date('fechaEmision', d.issueDate);
  w.optional('dirEstablecimiento', d.establishmentAddress);
  w.optional('contribuyenteEspecial', d.specialTaxpayerCode);
  w.element('obligadoContabilidad', d.accountingRequired ? 'SI' : 'NO');
  w.element('tipoIdentificacionComprador', d.customerIdType);
  w.element('razonSocialComprador', d.customerName);
  w.element('identificacionComprador', d.customerIdNumber);
  w.optional('direccionComprador', d.customerAddress);
  w.money('totalSinImpuestos', d.subtotal);
  w.money('totalDescuento', d.totalDiscount);
  w.open('totalConImpuestos');
  for (const tax of d.taxes) {
    w.open('totalImpuesto');
    w.element('codigo', tax.taxCode);
    w.element('codigoPorcentaje', tax.rateCode);
    w.money('baseImponible', tax.base);
    w.money('valor', tax.amount);
    w.close('totalImpuesto');
  }
  w.close('totalConImpuestos');
  w.money('propina', BigDecimal.ZERO);
  w.money('importeTotal', d.total);
  w.element('moneda', CURRENCY);
  w.open('pagos');
  for (const payment of d.payments) {
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
  w.close('infoFactura');

  w.open('detalles');
  for (const line of d.lines) {
    w.open('detalle');
    w.element('codigoPrincipal', line.mainCode);
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

  w.providerInfo(d.providerRuc);
  w.close('factura');
  return w.toBuffer();
}
