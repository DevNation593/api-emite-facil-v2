import { BigDecimal } from '../common/big-decimal.js';
import type { InvoiceXmlData } from '../xml/invoice-xml.js';
import { type PdfTable, renderDocument } from './pdf-table.js';
import * as layout from './ride-layout.js';

/*
 * Representación impresa (RIDE) de una factura autorizada, como delivery/RidePdfBuilder.java. El RIDE no sustituye
 * al XML firmado: lo representa. Las piezas comunes con las notas están en ride-layout.ts.
 */

/**
 * Lo que el RIDE de una factura autorizada muestra: los datos congelados del comprobante, su autorización, el correo
 * y el teléfono del cliente y el teléfono del emisor (los tres pueden ser nulos: no van en el XML) y el nombre de
 * cada forma de pago por código. `authorizedAt` es el instante en UTC (`YYYY-MM-DDTHH:MM:SS.ffffff`).
 */
export interface RideData {
  invoice: InvoiceXmlData;
  authorizationNumber: string | null;
  authorizedAt: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  issuerPhone: string | null;
  paymentMethodNames: ReadonlyMap<string, string>;
}

/** Solo un comprobante autorizado tiene RIDE. */
export function requireAuthorization(
  authorizationNumber: string | null,
  authorizedAt: string | null,
): { authorizationNumber: string; authorizedAt: string } {
  if (authorizationNumber === null || authorizationNumber.trim() === '' || authorizedAt === null) {
    throw new Error('Solo un comprobante autorizado tiene RIDE');
  }
  return { authorizationNumber, authorizedAt };
}

export async function buildInvoiceRide(data: RideData): Promise<Buffer> {
  const { authorizationNumber, authorizedAt } = requireAuthorization(data.authorizationNumber, data.authorizedAt);
  const { invoice } = data;
  const number = `${invoice.establishmentCode}-${invoice.emissionPointCode}-${String(invoice.sequence).padStart(9, '0')}`;
  return renderDocument(`Factura ${number}`, [
    layout.header(
      {
        legalName: invoice.issuerLegalName,
        tradeName: invoice.issuerTradeName,
        ruc: invoice.issuerRuc,
        headOfficeAddress: invoice.headOfficeAddress,
        establishmentAddress: invoice.establishmentAddress,
        accountingRequired: invoice.accountingRequired,
        specialTaxpayerCode: invoice.specialTaxpayerCode,
        withholdingAgentCode: invoice.withholdingAgentCode,
        rimpeRegime: invoice.rimpeRegime,
        phone: data.issuerPhone,
      },
      'FACTURA',
      number,
      invoice.environment,
      invoice.accessKey,
      authorizationNumber,
      authorizedAt,
    ),
    layout.SPACER,
    layout.recipientTable(
      { idType: invoice.customerIdType, idNumber: invoice.customerIdNumber, name: invoice.customerName },
      invoice.issueDate,
    ),
    layout.SPACER,
    detail(invoice),
    layout.SPACER,
    footer(data),
  ]);
}

/** Columnas del modelo; el descuento de cada línea ya está restado en su valor total. */
function detail(invoice: InvoiceXmlData): PdfTable {
  return linesTable(invoice.lines);
}

/** El detalle de la factura y de la nota de crédito. */
export function linesTable(
  lines: ReadonlyArray<{
    mainCode: string;
    quantity: BigDecimal;
    description: string;
    unitPrice: BigDecimal;
    subtotal: BigDecimal;
  }>,
): PdfTable {
  const table = layout.detailTable([13, 10, 51, 13, 13], 'CÓDIGO', 'CANTIDAD', 'DESCRIPCIÓN', 'V. UNITARIO', 'V. TOTAL');
  for (const line of lines) {
    table.add(layout.text(line.mainCode, 'left'));
    table.add(layout.text(layout.amount(line.quantity, 2), 'right'));
    table.add(layout.text(line.description, 'left'));
    table.add(layout.text(layout.amount(line.unitPrice, 2), 'right'));
    table.add(layout.text(layout.amount(line.subtotal, 2), 'right'));
  }
  return table;
}

function footer(data: RideData): PdfTable {
  const { invoice } = data;
  const below = layout.box();
  below.add(
    layout.wrap(
      layout.additionalInfo(data.customerEmail, invoice.customerAddress, data.customerPhone, invoice.providerRuc),
    ),
  );
  below.add(layout.gap());
  const payments = layout.paymentsTable();
  for (const payment of invoice.payments) {
    layout.payment(
      payments,
      payment.methodCode,
      data.paymentMethodNames.get(payment.methodCode),
      payment.amount,
      payment.term,
      payment.timeUnit,
    );
  }
  below.add(layout.wrap(payments));

  const totals = layout.totalsTable();
  layout.subtotalRows(totals, invoice.taxes);
  // La factura aún no admite propina.
  layout.total(totals, 'Propina', BigDecimal.ZERO);
  layout.total(totals, 'Descuento', invoice.totalDiscount);
  layout.vatRows(totals, invoice.taxes);
  layout.grandTotal(totals, 'TOTAL', invoice.total);
  return layout.footer(
    below,
    totals,
    `Favor remitir sus pagos y retenciones a nombre de "${invoice.issuerLegalName}"`,
  );
}
