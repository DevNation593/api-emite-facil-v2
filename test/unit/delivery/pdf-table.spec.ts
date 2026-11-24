import { breakLines, type Cell, type FontStyle, padding, PdfTable, renderDocument } from '../../../src/delivery/pdf-table.js';
import { inspectPdf } from '../../support/pdf-inspect.js';

const FONT: FontStyle = { bold: false, size: 8, color: '#000000' };

const cell = (text: string, extra: Partial<Cell> = {}): Cell => ({
  content: { kind: 'text', runs: [{ text, font: FONT }] },
  padding: padding(3),
  ...extra,
});

/** Una tabla de una columna con esas filas. */
function table(rows: string[], options: ConstructorParameters<typeof PdfTable>[1] = {}): PdfTable {
  const result = new PdfTable([1], options);
  for (const row of rows) result.add(cell(row));
  return result;
}

const texts = async (pdf: Buffer) => (await inspectPdf(pdf)).pages.map((page) => page.texts.map((item) => item.text));

const lines = (text: string, width: number) =>
  breakLines([{ text, font: FONT }], width).map((line) => line.runs.map((run) => run.text).join(''));

describe('salto de línea', () => {
  it('en el espacio, que no queda en ninguna de las dos líneas', () => {
    expect(lines('hola mundo', 25)).toEqual(['hola', 'mundo']);
  });

  it('tras el guion, que se queda en la primera', () => {
    expect(lines('CODIGO-MUY-LARGO-DE-VEINTICINCO', 62)).toEqual(['CODIGO-MUY-', 'LARGO-DE-', 'VEINTICINCO']);
  });

  it('una palabra que no cabe se reparte sin perder letras', () => {
    const parts = lines('x'.repeat(100), 100);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe('x'.repeat(100));
  });

  it('un ancho menor que una letra no se queda en bucle', () => {
    expect(lines('abc', 1)).toEqual(['a', 'b', 'c']);
  });

  it('sin texto no hay líneas', () => {
    expect(lines('', 100)).toEqual([]);
  });
});

it('una tabla sigue en la página siguiente y repite su encabezado', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => `fila ${i + 1}`);
  const pages = await texts(await renderDocument('t', [table(['encabezado', ...rows], { headerRows: 1 })]));
  expect(pages.length).toBe(3);
  for (const page of pages) expect(page[0]).toBe('encabezado');
  expect(pages.flatMap((page) => page.slice(1))).toEqual(rows);
});

it('keepTogether pasa la tabla entera a la página siguiente', async () => {
  const first = table(Array.from({ length: 50 }, (_, i) => `a${i}`));
  const kept = table(['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9'], { keepTogether: true });
  const pages = await texts(await renderDocument('t', [first, { spacer: 8 }, kept]));
  expect(pages.map((page) => page[0])).toEqual(['a0', 'b0']);
  expect(pages[1]!.length).toBe(10);
});

it('una fila que no cabe en una página vacía es un error, no un bucle', async () => {
  const huge = new PdfTable([1]);
  huge.add(cell(Array.from({ length: 4_000 }, () => 'palabra').join(' ')));
  await expect(renderDocument('t', [huge])).rejects.toThrow('no cabe en una página');
});

it('una celda más ancha que el hueco de la fila es un error del llamador', () => {
  const two = new PdfTable([1, 1]);
  two.add(cell('a'));
  expect(() => two.add(cell('b', { colspan: 2 }))).toThrow('no cabe');
});
