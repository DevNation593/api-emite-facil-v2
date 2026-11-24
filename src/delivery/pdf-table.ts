import bwipjs from 'bwip-js/node';
import PDFDocument from 'pdfkit';

/*
 * Tablas en un PDF A4 con la maquetación de PdfPTable y ColumnText de OpenPDF, que es la de los RIDE que Java ya
 * entregó: la interlínea es el cuerpo de la letra, la línea base queda a un cuerpo del borde interior de la celda,
 * el texto se parte en espacios y guiones, la fila mide lo que su celda más alta y una tabla sigue en la página
 * siguiente repitiendo sus filas de encabezado. Solo hace lo que el RIDE necesita. test/golden/ride.spec.ts compara
 * el resultado, posición a posición, con los PDF que generó Java.
 */

export interface FontStyle {
  bold: boolean;
  size: number;
  color: string;
  underline?: boolean;
}

export interface TextRun {
  text: string;
  font: FontStyle;
}

export type Align = 'left' | 'center' | 'right';

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type CellContent =
  | { kind: 'text'; runs: TextRun[] }
  | { kind: 'table'; table: PdfTable }
  /** Code 128 a todo el ancho de la celda, sin texto. */
  | { kind: 'barcode'; value: string };

export interface Cell {
  content: CellContent;
  align?: Align;
  padding: Padding;
  fill?: string;
  bottomBorder?: { color: string; width: number };
  colspan?: number;
  /** El texto va entero en una línea, aunque no quepa. */
  noWrap?: boolean;
  /** Centrado en vertical en una fila más alta que él; si no, arriba. */
  middle?: boolean;
}

export const padding = (all: number): Padding => ({ top: all, right: all, bottom: all, left: all });

export class PdfTable {
  readonly rows: Cell[][] = [];
  private free = 0;

  constructor(
    /** Anchos relativos de las columnas. */
    readonly widths: readonly number[],
    readonly options: {
      /** Primeras filas que se repiten en cada página. */
      headerRows?: number;
      /** Si no cabe en lo que queda de página, pasa entera a la siguiente. */
      keepTogether?: boolean;
    } = {},
  ) {}

  add(cell: Cell): void {
    const span = cell.colspan ?? 1;
    if (this.free === 0) {
      this.rows.push([]);
      this.free = this.widths.length;
    }
    if (span > this.free) throw new Error('La celda no cabe en lo que queda de la fila');
    this.rows.at(-1)!.push(cell);
    this.free -= span;
  }
}

/** Un bloque del documento: una tabla o un hueco de esa altura. */
export type Block = PdfTable | { spacer: number };

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 28;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const BOTTOM = PAGE_HEIGHT - MARGIN;
/** Margen para los errores de redondeo al comparar alturas. */
const EPSILON = 0.001;

const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';

// ------------------------------------------------------------------- medidas

interface AfmFont {
  getKernPair(left: string, right: string): number;
}

/**
 * Un documento con las dos letras sin interletraje (OpenPDF no lo aplica y pdfkit sí): cada carácter avanza su
 * ancho, así que lo que se mide es lo que se dibuja.
 */
function newDocument(title: string): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: [PAGE_WIDTH, PAGE_HEIGHT], margin: 0, info: { Title: title } });
  for (const name of [REGULAR, BOLD]) {
    doc.font(name);
    const { font } = (doc as unknown as { _font: { font: AfmFont } })._font;
    font.getKernPair = () => 0;
  }
  return doc;
}

const widthCache = new Map<string, number>();
let measuring: PDFKit.PDFDocument | null = null;

/** El guion blando no ocupa sitio al partir líneas (PdfChunk.noPrint). */
const SOFT_HYPHEN = '­';

function charWidth(character: string, font: FontStyle): number {
  if (character === SOFT_HYPHEN) return 0;
  const key = `${font.bold ? 'b' : 'r'}${character}`;
  let width = widthCache.get(key);
  if (width === undefined) {
    measuring ??= newDocument('');
    width = measuring.font(font.bold ? BOLD : REGULAR).fontSize(1000).widthOfString(character);
    widthCache.set(key, width);
  }
  return (width * font.size) / 1000;
}

interface Char {
  char: string;
  font: FontStyle;
  width: number;
}

interface TextLine {
  runs: TextRun[];
  width: number;
  /** El cuerpo mayor de la línea: su interlínea. */
  leading: number;
}

/** Dónde se puede partir una línea: tras un espacio o un guion (DefaultSplitCharacter). */
const isSplit = (char: string): boolean => char <= ' ' || char === '-' || char === '‐';

const isBlank = (char: string): boolean => char <= ' ';

function lineOf(chars: readonly Char[], all: readonly Char[]): TextLine {
  const runs: TextRun[] = [];
  for (const { char, font } of chars) {
    const last = runs.at(-1);
    if (last !== undefined && last.font === font) last.text += char;
    else runs.push({ text: char, font });
  }
  return {
    runs,
    width: chars.reduce((sum, { width }) => sum + width, 0),
    leading: Math.max(...(chars.length > 0 ? chars : all).map(({ font }) => font.size)),
  };
}

/** Reparte los tramos en líneas de ese ancho, como BidiLine.processLine. */
export function breakLines(runs: readonly TextRun[], width: number): TextLine[] {
  const chars: Char[] = runs.flatMap(({ text, font }) =>
    Array.from(text, (char) => ({ char, font, width: charWidth(char, font) })),
  );
  const lines: TextLine[] = [];
  let current = 0;
  while (current < chars.length) {
    // Una línea que no es la primera no empieza con espacios.
    if (current !== 0) while (current < chars.length && isBlank(chars[current]!.char)) current++;
    if (current >= chars.length) break;
    const start = current;
    let lastSplit = -1;
    let left = width;
    for (; current < chars.length; current++) {
      const { char, width: own } = chars[current]!;
      if (char === SOFT_HYPHEN) continue;
      const split = isSplit(char);
      if (split && isBlank(char)) lastSplit = current;
      if (left - own < 0) break;
      if (split) lastSplit = current;
      left -= own;
    }
    if (current === start) {
      // Ni un carácter cabe: va solo, para no quedarse aquí para siempre.
      current++;
      lines.push(lineOf(chars.slice(start, current), chars));
      continue;
    }
    if (current >= chars.length) {
      lines.push(lineOf(chars.slice(start), chars));
      break;
    }
    let end = trimEnd(chars, start, current - 1);
    if (end < start) {
      // Solo espacios.
      lines.push(lineOf(chars.slice(start, current), chars));
      continue;
    }
    if (lastSplit >= 0 && lastSplit < end) {
      current = lastSplit + 1;
      end = trimEnd(chars, start, lastSplit);
      if (end < start) end = current - 1;
    }
    lines.push(lineOf(chars.slice(start, end + 1), chars));
  }
  return lines;
}

/** El último carácter de [start, end] que no es un espacio; start - 1 si no hay ninguno. */
function trimEnd(chars: readonly Char[], start: number, end: number): number {
  let last = end;
  while (last >= start && isBlank(chars[last]!.char)) last--;
  return last;
}

// ---------------------------------------------------------------- maquetación

/** Alto de las barras y ancho de un módulo del Code 128, antes de ajustarlo a la celda. */
const BAR_HEIGHT = 30;
const MODULE = 0.8;

type Laid =
  | { kind: 'text'; lines: TextLine[]; height: number }
  | { kind: 'table'; rows: LaidRow[]; height: number }
  | { kind: 'barcode'; bars: number[]; scale: number; height: number };

interface LaidCell {
  cell: Cell;
  x: number;
  width: number;
  /** Alto del contenido con sus márgenes; la celda mide lo que su fila. */
  height: number;
  laid: Laid;
}

interface LaidRow {
  cells: LaidCell[];
  height: number;
}

/** Anchos en módulos de barras y espacios alternos, empezando por una barra. */
export function barcodeModules(value: string): number[] {
  const [symbol] = bwipjs.raw('code128', value, '') as Array<{ sbs: number[] }>;
  return symbol!.sbs.map((width) => Math.round(width));
}

function layCell(cell: Cell, width: number): Laid {
  const inner = width - cell.padding.left - cell.padding.right;
  switch (cell.content.kind) {
    case 'text': {
      const lines = breakLines(cell.content.runs, cell.noWrap === true ? Number.POSITIVE_INFINITY : inner);
      return { kind: 'text', lines, height: lines.reduce((sum, line) => sum + line.leading, 0) };
    }
    case 'table': {
      const rows = layTable(cell.content.table, inner);
      return { kind: 'table', rows, height: rows.reduce((sum, row) => sum + row.height, 0) };
    }
    case 'barcode': {
      const bars = barcodeModules(cell.content.value);
      const scale = inner / (bars.reduce((sum, bar) => sum + bar, 0) * MODULE);
      return { kind: 'barcode', bars, scale, height: BAR_HEIGHT * scale };
    }
  }
}

function layTable(table: PdfTable, width: number): LaidRow[] {
  const total = table.widths.reduce((sum, own) => sum + own, 0);
  const columns = table.widths.map((own) => (own / total) * width);
  return table.rows.map((row) => {
    let column = 0;
    let x = 0;
    const cells = row.map((cell): LaidCell => {
      const span = cell.colspan ?? 1;
      const own = columns.slice(column, column + span).reduce((sum, w) => sum + w, 0);
      const laid = layCell(cell, own);
      const placed = { cell, x, width: own, laid, height: laid.height + cell.padding.top + cell.padding.bottom };
      column += span;
      x += own;
      return placed;
    });
    return { cells, height: Math.max(...cells.map(({ height }) => height)) };
  });
}

const heightOf = (rows: readonly LaidRow[]): number => rows.reduce((sum, row) => sum + row.height, 0);

// -------------------------------------------------------------------- dibujo

/** Lo que se dibuja de una tabla en una página: los fondos primero, luego las rayas y al final los textos. */
interface Layers {
  fills: Array<() => void>;
  borders: Array<() => void>;
  texts: Array<() => void>;
}

function drawLine(doc: PDFKit.PDFDocument, line: TextLine, x: number, baseline: number): void {
  let at = x;
  for (const { text, font } of line.runs) {
    const width = Array.from(text).reduce((sum, char) => sum + charWidth(char, font), 0);
    if (font.underline === true) {
      const y = baseline + font.size / 3;
      doc.lineWidth(font.size / 15).strokeColor(font.color).moveTo(at, y).lineTo(at + width, y).stroke();
    }
    if (text.trim() !== '') {
      doc
        .font(font.bold ? BOLD : REGULAR)
        .fontSize(font.size)
        .fillColor(font.color)
        .text(text, at, baseline, { lineBreak: false, baseline: 'alphabetic' });
    }
    at += width;
  }
}

function collect(doc: PDFKit.PDFDocument, rows: readonly LaidRow[], left: number, top: number, layers: Layers): void {
  let y = top;
  for (const row of rows) {
    for (const { cell, x, width, laid, height } of row.cells) {
      const cellX = left + x;
      const cellY = y;
      const { fill, bottomBorder } = cell;
      if (fill !== undefined) {
        layers.fills.push(() => doc.rect(cellX, cellY, width, row.height).fill(fill));
      }
      if (bottomBorder !== undefined) {
        const bottom = cellY + row.height;
        layers.borders.push(() =>
          doc
            .lineCap('square')
            .lineWidth(bottomBorder.width)
            .strokeColor(bottomBorder.color)
            .moveTo(cellX, bottom)
            .lineTo(cellX + width, bottom)
            .stroke()
            .lineCap('butt'),
        );
      }
      const innerX = cellX + cell.padding.left;
      const innerY = cellY + cell.padding.top + (cell.middle === true ? (row.height - height) / 2 : 0);
      const innerWidth = width - cell.padding.left - cell.padding.right;
      switch (laid.kind) {
        case 'text': {
          let baseline = innerY;
          for (const line of laid.lines) {
            baseline += line.leading;
            const slack = innerWidth - line.width;
            const offset = cell.align === 'right' ? slack : cell.align === 'center' ? slack / 2 : 0;
            const at = baseline;
            layers.texts.push(() => drawLine(doc, line, innerX + offset, at));
          }
          break;
        }
        case 'table':
          collect(doc, laid.rows, innerX, innerY, layers);
          break;
        case 'barcode': {
          // OpenPDF escribe la escala con dos decimales: las barras miden lo mismo que en Java.
          const scale = Math.round(laid.scale * 100) / 100;
          const bottom = innerY + laid.height;
          layers.texts.push(() => {
            let at = innerX;
            laid.bars.forEach((bar, i) => {
              const barWidth = bar * MODULE * scale;
              if (i % 2 === 0) doc.rect(at, bottom - BAR_HEIGHT * scale, barWidth, BAR_HEIGHT * scale);
              at += barWidth;
            });
            doc.fill('#000000');
          });
          break;
        }
      }
    }
    y += row.height;
  }
}

function draw(doc: PDFKit.PDFDocument, rows: readonly LaidRow[], top: number): void {
  const layers: Layers = { fills: [], borders: [], texts: [] };
  collect(doc, rows, MARGIN, top, layers);
  for (const layer of [layers.fills, layers.borders, layers.texts]) for (const paint of layer) paint();
}

/** Dibuja los bloques uno bajo otro, con los saltos de página que hagan falta, y devuelve el PDF. */
export function renderDocument(title: string, blocks: readonly Block[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = newDocument(title);
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      let y = MARGIN;
      const newPage = () => {
        doc.addPage();
        y = MARGIN;
      };
      for (const block of blocks) {
        if (!(block instanceof PdfTable)) {
          // PdfDocument.carriageReturn pide sitio para el hueco y una línea más.
          if (y + 2 * block.spacer >= BOTTOM) newPage();
          y += block.spacer;
          continue;
        }
        const rows = layTable(block, CONTENT_WIDTH);
        if (block.options.keepTogether === true && y > MARGIN && y + heightOf(rows) > BOTTOM + EPSILON) newPage();
        const header = rows.slice(0, block.options.headerRows ?? 0);
        let next = header.length;
        do {
          const fits: LaidRow[] = [...header];
          let end = y + heightOf(header);
          while (next < rows.length && end + rows[next]!.height <= BOTTOM + EPSILON) {
            end += rows[next]!.height;
            fits.push(rows[next]!);
            next++;
          }
          if (fits.length > header.length || rows.length === header.length) {
            draw(doc, fits, y);
            y = end;
          } else if (y <= MARGIN) {
            throw new Error('Una fila de la tabla no cabe en una página');
          }
          if (next < rows.length) newPage();
        } while (next < rows.length);
      }
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
