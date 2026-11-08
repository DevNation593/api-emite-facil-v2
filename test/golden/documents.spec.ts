import { readFileSync } from 'node:fs';
import { BigDecimal } from '../../src/common/big-decimal.js';
import type { DocumentEnvelope } from '../../src/billing/document-envelope.js';
import {
  buildCreditNoteXml,
  CREDIT_NOTE_CODEC,
  type CreditNoteContent,
} from '../../src/notes/credit-note-content.js';
import {
  buildDebitNoteXml,
  DEBIT_NOTE_CODEC,
  type DebitNoteContent,
} from '../../src/notes/debit-note-content.js';
import { documentTypeOf } from '../../src/xml/document-type.js';
import {
  buildInvoiceXml,
  type InvoiceXmlData,
} from '../../src/xml/invoice-xml.js';

// XML de factura y notas, y JSON del contenido de las notas, generados con el código Java
// (tools/golden-generator, familia documents). Los decimales llegan como cadenas con su escala.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Case {
  name: string;
  type: '01' | '04' | '05';
  data: any;
  xml: string | null;
  contentJson: string | null;
}
const { cases } = JSON.parse(
  readFileSync(new URL('./documents.json', import.meta.url), 'utf8'),
) as {
  cases: Case[];
};
const file = (path: string) =>
  readFileSync(new URL(`./${path}`, import.meta.url));

const dec = (text: string): BigDecimal => BigDecimal.of(text);
const decOrNull = (text: string | null): BigDecimal | null =>
  text === null ? null : dec(text);
const taxes = (raw: any[]) =>
  raw.map((t) => ({
    taxCode: t.taxCode,
    rateCode: t.rateCode,
    rate: dec(t.rate),
    base: dec(t.base),
    amount: dec(t.amount),
  }));

function invoiceOf(raw: any): InvoiceXmlData {
  return {
    ...raw,
    subtotal: dec(raw.subtotal),
    totalDiscount: dec(raw.totalDiscount),
    taxes: taxes(raw.taxes),
    total: dec(raw.total),
    lines: raw.lines.map((l: any) => ({
      ...l,
      quantity: dec(l.quantity),
      unitPrice: dec(l.unitPrice),
      discount: dec(l.discount),
      subtotal: dec(l.subtotal),
      taxRate: dec(l.taxRate),
      taxAmount: dec(l.taxAmount),
    })),
    payments: raw.payments.map((p: any) => ({
      ...p,
      amount: dec(p.amount),
      term: decOrNull(p.term),
    })),
  };
}

function envelopeOf(raw: any): DocumentEnvelope {
  return {
    ...raw,
    type: documentTypeOf(raw.type),
    totals: {
      subtotal: decOrNull(raw.totals.subtotal),
      totalDiscount: decOrNull(raw.totals.totalDiscount),
      totalTax: decOrNull(raw.totals.totalTax),
      total: dec(raw.totals.total),
    },
  };
}

const creditOf = (raw: any): CreditNoteContent => ({
  reason: raw.reason,
  lines: raw.lines.map((l: any) => ({
    ...l,
    quantity: dec(l.quantity),
    unitPrice: dec(l.unitPrice),
    discount: dec(l.discount),
    subtotal: dec(l.subtotal),
    taxRate: dec(l.taxRate),
    taxAmount: dec(l.taxAmount),
  })),
  taxes: taxes(raw.taxes),
});

const debitOf = (raw: any): DebitNoteContent => ({
  reasons: raw.reasons.map((r: any) => ({
    ...r,
    value: dec(r.value),
    taxRate: dec(r.taxRate),
    taxAmount: dec(r.taxAmount),
  })),
  taxes: taxes(raw.taxes),
  payments: raw.payments.map((p: any) => ({
    ...p,
    amount: dec(p.amount),
    term: decOrNull(p.term),
  })),
});

it('el golden trae los tres tipos y los casos pedidos', () => {
  expect(cases.length).toBeGreaterThanOrEqual(13);
  for (const type of ['01', '04', '05'])
    expect(cases.some((c) => c.type === type)).toBe(true);
  expect(
    cases.filter((c) => c.type !== '01').every((c) => c.contentJson !== null),
  ).toBe(true);
  expect(
    cases.filter((c) => c.type === '01').every((c) => c.contentJson === null),
  ).toBe(true);
});

it.each(cases.map((c) => [c.name, c] as const))(
  '%s: mismos bytes de XML y mismo contenido JSON',
  (_name, c) => {
    const content =
      c.type === '04'
        ? creditOf(c.data.content)
        : c.type === '05'
          ? debitOf(c.data.content)
          : undefined;
    const envelope = c.type === '01' ? undefined : envelopeOf(c.data.envelope);

    if (c.xml !== null) {
      const expected = file(c.xml);
      const actual =
        c.type === '01'
          ? buildInvoiceXml(invoiceOf(c.data))
          : c.type === '04'
            ? buildCreditNoteXml(
                envelope as DocumentEnvelope,
                content as CreditNoteContent,
              )
            : buildDebitNoteXml(
                envelope as DocumentEnvelope,
                content as DebitNoteContent,
              );
      expect(actual.equals(expected)).toBe(true);
    }

    if (c.type === '01') return;
    const codec = c.type === '04' ? CREDIT_NOTE_CODEC : DEBIT_NOTE_CODEC;
    const json = c.contentJson as string;
    expect(codec.write(content as never)).toBe(json);
    expect(codec.write(codec.read(json) as never)).toBe(json);
    expect(codec.read(json)).toEqual(content);
  },
);
