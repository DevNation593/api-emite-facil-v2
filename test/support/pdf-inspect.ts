import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

/*
 * Lee un PDF con pdfjs y devuelve lo que se ve: los tramos de texto con su posición, letra y color, los rectángulos
 * de color y las rayas. Las coordenadas son las del PDF (origen abajo a la izquierda). Sirve para comparar el RIDE
 * de NestJS con el de Java aunque sus flujos de contenido se escriban de otra forma.
 */

export interface PdfText {
  x: number;
  y: number;
  /** Donde termina el tramo. */
  end: number;
  size: number;
  bold: boolean;
  color: string;
  text: string;
}

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface PdfLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  color: string;
}

export interface PdfPage {
  texts: PdfText[];
  rects: PdfRect[];
  lines: PdfLine[];
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m × n: primero m y después n. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

interface State {
  ctm: Matrix;
  fill: string;
  stroke: string;
  lineWidth: number;
  font: string;
  size: number;
}

interface Glyph {
  unicode: string;
  width: number;
}

const list = (value: unknown): number[] => Object.values(value as Record<string, number>);

/** Los subtrazados de un trazado de pdfjs: 0 mover, 1 línea, 2 curva, 4 cerrar. */
function subpaths(data: number[]): Array<Array<[number, number]>> {
  const paths: Array<Array<[number, number]>> = [];
  for (let i = 0; i < data.length; ) {
    switch (data[i]) {
      case 0:
        paths.push([[data[i + 1]!, data[i + 2]!]]);
        i += 3;
        break;
      case 1:
        paths.at(-1)!.push([data[i + 1]!, data[i + 2]!]);
        i += 3;
        break;
      case 4:
        i += 1;
        break;
      default:
        throw new Error(`Trazado inesperado: ${data[i]}`);
    }
  }
  return paths;
}

export async function inspectPdf(pdf: Buffer): Promise<{ title: string | null; pages: PdfPage[] }> {
  const task = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true, verbosity: 0 });
  const document = await task.promise;
  try {
    const info = (await document.getMetadata()).info as { Title?: string };
    const pages: PdfPage[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const operators = await page.getOperatorList();
      const bold = (font: string): boolean => {
        const object = page.commonObjs.get(font) as { name?: string; bold?: boolean };
        return object.bold === true || /Bold/.test(object.name ?? '');
      };
      const found: PdfPage = { texts: [], rects: [], lines: [] };
      let state: State = { ctm: IDENTITY, fill: '#000000', stroke: '#000000', lineWidth: 1, font: '', size: 0 };
      const stack: State[] = [];
      let text: Matrix = IDENTITY;
      let line: Matrix = IDENTITY;
      const show = (glyphs: Array<Glyph | number>) => {
        for (const glyph of glyphs) {
          if (typeof glyph === 'number') {
            text = multiply([1, 0, 0, 1, (-glyph / 1000) * state.size, 0], text);
            continue;
          }
          const [x, y] = apply(multiply(text, state.ctm), 0, 0);
          text = multiply([1, 0, 0, 1, (glyph.width / 1000) * state.size, 0], text);
          const [end] = apply(multiply(text, state.ctm), 0, 0);
          const item: PdfText = { x, y, end, size: state.size, bold: bold(state.font), color: state.fill, text: glyph.unicode };
          const last = found.texts.at(-1);
          // Un tramo sigue si el carácter va pegado al anterior, con la misma letra y el mismo color.
          if (
            last !== undefined &&
            Math.abs(last.end - x) < 0.05 &&
            Math.abs(last.y - y) < 0.01 &&
            last.size === item.size &&
            last.bold === item.bold &&
            last.color === item.color
          ) {
            last.text += item.text;
            last.end = end;
          } else {
            found.texts.push(item);
          }
        }
      };
      operators.fnArray.forEach((fn, i) => {
        const args = operators.argsArray[i] as unknown[];
        switch (fn) {
          case OPS.save:
            stack.push({ ...state });
            break;
          case OPS.restore:
            state = stack.pop()!;
            break;
          case OPS.transform:
            state.ctm = multiply(list(args) as Matrix, state.ctm);
            break;
          case OPS.paintFormXObjectBegin:
            stack.push({ ...state });
            state.ctm = multiply((args[0] === null ? IDENTITY : list(args[0])) as Matrix, state.ctm);
            break;
          case OPS.paintFormXObjectEnd:
            state = stack.pop()!;
            break;
          case OPS.setFillRGBColor:
            state.fill = args[0] as string;
            break;
          case OPS.setStrokeRGBColor:
            state.stroke = args[0] as string;
            break;
          case OPS.setLineWidth:
            state.lineWidth = args[0] as number;
            break;
          case OPS.setFont:
            state.font = args[0] as string;
            state.size = args[1] as number;
            break;
          case OPS.beginText:
            text = IDENTITY;
            line = IDENTITY;
            break;
          case OPS.setTextMatrix:
            text = line = list(args[0]) as Matrix;
            break;
          case OPS.moveText:
            text = line = multiply([1, 0, 0, 1, args[0] as number, args[1] as number], line);
            break;
          case OPS.showText:
          case OPS.showSpacedText:
            show(args[0] as Array<Glyph | number>);
            break;
          case OPS.constructPath: {
            const [kind, data] = args as [number, unknown[]];
            for (const raw of data) {
              if (raw === null) continue;
              for (const points of subpaths(list(raw))) {
                const moved = points.map(([x, y]) => apply(state.ctm, x, y));
                const xs = moved.map(([x]) => x);
                const ys = moved.map(([, y]) => y);
                if (kind === OPS.fill || kind === OPS.eoFill) {
                  found.rects.push({
                    x: Math.min(...xs),
                    y: Math.min(...ys),
                    width: Math.max(...xs) - Math.min(...xs),
                    height: Math.max(...ys) - Math.min(...ys),
                    color: state.fill,
                  });
                } else if (kind === OPS.stroke) {
                  found.lines.push({
                    x1: xs[0]!,
                    y1: ys[0]!,
                    x2: xs.at(-1)!,
                    y2: ys.at(-1)!,
                    width: state.lineWidth * Math.abs(state.ctm[0]),
                    color: state.stroke,
                  });
                }
              }
            }
            break;
          }
          default:
            break;
        }
      });
      // Los tramos en blanco no se ven; los espacios del final, tampoco.
      found.texts = found.texts
        .filter((item) => item.text.trim() !== '')
        .map((item) => ({ ...item, text: item.text.trimEnd() }));
      // Las barras de ancho cero con que Barcode128 rellena el código tampoco.
      found.rects = found.rects.filter((rect) => rect.width > 0.001);
      pages.push(found);
    }
    return { title: info.Title ?? null, pages };
  } finally {
    await task.destroy();
  }
}

/** Todo el texto en orden de lectura, con los espacios normalizados, como el `text` de RidePdfBuilderTest. */
export async function pdfText(pdf: Buffer): Promise<string> {
  const { pages } = await inspectPdf(pdf);
  return pages
    .flatMap((page) => page.texts)
    .map((item) => item.text)
    .join(' ')
    .replace(/\s+/g, ' ');
}
