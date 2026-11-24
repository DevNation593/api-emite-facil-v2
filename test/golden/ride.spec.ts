import { readFileSync } from 'node:fs';
import type { DocumentEnvelope } from '../../src/billing/document-envelope.js';
import { BigDecimal } from '../../src/common/big-decimal.js';
import { buildInvoiceRide } from '../../src/delivery/invoice-ride.js';
import { barcodeModules } from '../../src/delivery/pdf-table.js';
import { amount, clean, percent, rateLabel } from '../../src/delivery/ride-layout.js';
import type { CreditNoteContent } from '../../src/notes/credit-note-content.js';
import type { DebitNoteContent } from '../../src/notes/debit-note-content.js';
import { buildCreditNoteRide, buildDebitNoteRide } from '../../src/notes/note-ride.js';
import { documentTypeOf } from '../../src/xml/document-type.js';
import type { InvoiceXmlData } from '../../src/xml/invoice-xml.js';
import { inspectPdf, type PdfPage } from '../support/pdf-inspect.js';

// RIDE generado con el código Java (tools/golden-generator, familia ride): el de NestJS tiene las mismas páginas y,
// en el mismo sitio, los mismos textos, fondos, rayas y barras. OpenPDF escribe las coordenadas con dos decimales.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Case {
  name: string;
  type: '01' | '04' | '05';
  authorizationNumber: string;
  authorizedAt: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  issuerPhone?: string | null;
  paymentMethodNames: Record<string, string>;
  data: any;
}
const golden = JSON.parse(readFileSync(new URL('./ride.json', import.meta.url), 'utf8')) as {
  cases: Case[];
  amounts: Array<{ value: string; minScale: number; result: string }>;
  percents: Array<{ value: string; result: string }>;
  labels: Array<{ rateCode: string; rate: string; result: string }>;
  clean: Array<{ value: string | null; result: string }>;
  barcodes: Array<{ code: string; bars: string }>;
};

/** Diferencia admitida en una coordenada, en puntos (1/72 de pulgada). */
const TOLERANCE = 0.15;

const DECIMALS = new Set([
  'subtotal',
  'totalDiscount',
  'totalTax',
  'total',
  'rate',
  'base',
  'amount',
  'quantity',
  'unitPrice',
  'discount',
  'taxRate',
  'taxAmount',
  'term',
  'value',
]);

/** Los decimales llegan como cadenas con su escala. */
function decimals(value: any, key = ''): any {
  if (Array.isArray(value)) return value.map((item) => decimals(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decimals(v, k)]));
  }
  return typeof value === 'string' && DECIMALS.has(key) ? BigDecimal.of(value) : value;
}

function build(c: Case): Promise<Buffer> {
  const names = new Map(Object.entries(c.paymentMethodNames));
  if (c.type === '01') {
    return buildInvoiceRide({
      invoice: decimals(c.data) as InvoiceXmlData,
      authorizationNumber: c.authorizationNumber,
      authorizedAt: c.authorizedAt,
      customerEmail: c.customerEmail ?? null,
      customerPhone: c.customerPhone ?? null,
      issuerPhone: c.issuerPhone ?? null,
      paymentMethodNames: names,
    });
  }
  const { envelope: raw, content } = decimals(c.data);
  const envelope = { ...raw, type: documentTypeOf(raw.type) } as DocumentEnvelope;
  const ride = { envelope, authorizationNumber: c.authorizationNumber, authorizedAt: c.authorizedAt };
  return c.type === '04'
    ? buildCreditNoteRide(ride, content as CreditNoteContent)
    : buildDebitNoteRide(ride, content as DebitNoteContent, names);
}

const byPosition = <T extends { x: number; y: number }>(items: T[]): T[] =>
  [...items].sort((a, b) => Math.round(b.y * 2) - Math.round(a.y * 2) || a.x - b.x);

/** Lo que debe coincidir exactamente de una página, y sus coordenadas aparte. */
function describePage(page: PdfPage) {
  const texts = byPosition(page.texts);
  const rects = byPosition(page.rects);
  const lines = byPosition(page.lines.map((line) => ({ ...line, x: line.x1, y: line.y1 })));
  return {
    exact: {
      texts: texts.map(({ text, size, bold, color }) => ({ text, size, bold, color })),
      rects: rects.map(({ color }) => color),
      lines: lines.map(({ color, width }) => `${color} ${width.toFixed(2)}`),
    },
    coordinates: [
      ...texts.map(({ x, y, text }) => ({ what: text, values: [x, y] })),
      ...rects.map(({ x, y, width, height, color }, i) => ({ what: `fondo ${i} ${color}`, values: [x, y, width, height] })),
      ...lines.map(({ x1, y1, x2, y2 }, i) => ({ what: `raya ${i}`, values: [x1, y1, x2, y2] })),
    ],
  };
}

it.each(golden.cases)('RIDE $name', async (c) => {
  const expected = await inspectPdf(readFileSync(new URL(`./ride/${c.name}.pdf`, import.meta.url)));
  const actual = await inspectPdf(await build(c));

  expect(actual.title).toBe(expected.title);
  expect(actual.pages.length).toBe(expected.pages.length);
  expected.pages.forEach((page, i) => {
    const want = describePage(page);
    const got = describePage(actual.pages[i]!);
    expect(got.exact).toEqual(want.exact);
    const far = want.coordinates.flatMap(({ what, values }, j) =>
      values.some((value, k) => Math.abs(value - got.coordinates[j]!.values[k]!) > TOLERANCE)
        ? [{ page: i + 1, what, want: values, got: got.coordinates[j]!.values }]
        : [],
    );
    expect(far).toEqual([]);
  });
});

it.each(golden.amounts)('importe $value con $minScale decimales o más', ({ value, minScale, result }) => {
  expect(amount(BigDecimal.of(value), minScale)).toBe(result);
});

it.each(golden.percents)('tarifa $value', ({ value, result }) => {
  expect(percent(BigDecimal.of(value))).toBe(result);
});

it.each(golden.labels)('etiqueta de la tarifa $rateCode', ({ rateCode, rate, result }) => {
  expect(rateLabel(rateCode, BigDecimal.of(rate))).toBe(result);
});

it.each(golden.clean.map((c, i) => [i, c] as const))('texto %i', (_i, { value, result }) => {
  expect(clean(value)).toBe(result);
});

it.each(golden.barcodes)('barras de $code', ({ code, bars }) => {
  // Barcode128 devuelve al final barras de ancho cero.
  expect(barcodeModules(code).join('')).toBe(bars.replace(/0+$/, ''));
});
