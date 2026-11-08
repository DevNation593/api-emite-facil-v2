import { readFileSync } from 'node:fs';
import { BigDecimal } from '../../src/common/big-decimal.js';
import {
  buildInvoiceXml,
  type InvoiceXmlData,
} from '../../src/xml/invoice-xml.js';

// El XML sin firmar de los casos XAdES (factura estándar y con RUC del proveedor) es el que la firma de E4 usará
// como entrada: el generador de facturas debe reproducirlo byte a byte a partir de los datos de documents.json.
/* eslint-disable @typescript-eslint/no-explicit-any */
const { cases } = JSON.parse(
  readFileSync(new URL('./documents.json', import.meta.url), 'utf8'),
) as {
  cases: { name: string; data: any }[];
};
const dec = (text: string | null): BigDecimal | null =>
  text === null ? null : BigDecimal.of(text);
const money = (text: string) => BigDecimal.of(text);

function invoiceOf(raw: any): InvoiceXmlData {
  return {
    ...raw,
    subtotal: money(raw.subtotal),
    totalDiscount: money(raw.totalDiscount),
    taxes: raw.taxes.map((t: any) => ({
      ...t,
      rate: money(t.rate),
      base: money(t.base),
      amount: money(t.amount),
    })),
    total: money(raw.total),
    lines: raw.lines.map((l: any) => ({
      ...l,
      quantity: money(l.quantity),
      unitPrice: money(l.unitPrice),
      discount: money(l.discount),
      subtotal: money(l.subtotal),
      taxRate: money(l.taxRate),
      taxAmount: money(l.taxAmount),
    })),
    payments: raw.payments.map((p: any) => ({
      ...p,
      amount: money(p.amount),
      term: dec(p.term),
    })),
  };
}

it.each(['factura-estandar', 'factura-con-ruc-proveedor'])(
  '%s: el XML sin firmar de XAdES se reproduce',
  (name) => {
    const found = cases.find((c) => c.name === name);
    expect(found).toBeDefined();
    const unsigned = readFileSync(
      new URL(`./xades/${name}/unsigned.xml`, import.meta.url),
    );
    expect(buildInvoiceXml(invoiceOf(found!.data)).equals(unsigned)).toBe(true);
  },
);
