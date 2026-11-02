import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// La regla de lint contra `number` en el código fiscal (scripts/check-fiscal-numbers.mjs).
const SCRIPT = 'scripts/check-fiscal-numbers.mjs';
// Cada ejecución arranca el comprobador de tipos (unos segundos con la máquina cargada).
vi.setConfig({ testTimeout: 30_000 });
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fiscal-numbers-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function check(files: Record<string, string>): { status: number | null; output: string } {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const run = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

it('falla con un importe de tipo number y con parseFloat, y nombra las dos líneas', () => {
  const { status, output } = check({
    'line.ts': ['export interface Line {', '  total: number;', '}', 'export const read = (x: string) => parseFloat(x);', ''].join('\n'),
  });
  expect(status).toBe(1);
  expect(output).toMatch(/line\.ts:2\b.*total/);
  expect(output).toMatch(/line\.ts:4\b.*parseFloat/);
});

it('pasa con un importe de tipo BigDecimal', () => {
  const { status, output } = check({
    'line.ts': [
      'class BigDecimal { toFixed(_d: number): string { return String(_d); } }',
      'export interface Line {',
      '  total: BigDecimal;',
      '  discount?: BigDecimal | null;',
      '}',
      "export const show = (line: Line) => line.total.toFixed(2) + (line.discount?.toFixed(2) ?? '');",
      '',
    ].join('\n'),
  });
  expect(output).toBe('');
  expect(status).toBe(0);
});

it('detecta parámetros, Number.parseFloat, Math.round, toFixed sobre number y new Decimal', () => {
  const { status, output } = check({
    'sub/calc.ts': [
      'class Decimal { constructor(_v: string) {} toFixed(_d: number): string { return String(_d); } }',
      'export function f(quantity: number, rate?: number | null): string {',
      '  const a = Number.parseFloat(String(quantity));',
      '  const b = Math.round(a);',
      "  const c = new Decimal('1');",
      '  return b.toFixed(2) + c.toFixed(2);',
      '}',
      '',
    ].join('\n'),
  });
  expect(status).toBe(1);
  expect(output).toMatch(/calc\.ts:2\b.*quantity/);
  expect(output).toMatch(/calc\.ts:2\b.*rate/);
  expect(output).toMatch(/calc\.ts:3\b.*parseFloat/);
  expect(output).toMatch(/calc\.ts:4\b.*Math\.round/);
  expect(output).toMatch(/calc\.ts:5\b.*new Decimal/);
  expect(output).toMatch(/calc\.ts:6\b.*toFixed/);
  // c.toFixed es de un Decimal: solo una queja por toFixed.
  expect(output.split(/\r?\n/).filter((line) => line.includes('toFixed sobre'))).toHaveLength(1);
});

it('admite una excepción con su motivo en la línea anterior', () => {
  const { status, output } = check({
    'page.ts': [
      'export interface Page {',
      '  // fiscal-number-ok: cuenta de filas, no un importe',
      '  total: number;',
      '  // fiscal-number-ok:',
      '  value: number;',
      '}',
      '',
    ].join('\n'),
  });
  expect(status).toBe(1);
  expect(output).not.toMatch(/page\.ts:3\b/);
  expect(output).toMatch(/page\.ts:5\b.*value/);
});

it('sin argumentos revisa el código fiscal del repositorio y pasa', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  expect(`${run.stdout}${run.stderr}`).toBe('');
  expect(run.status).toBe(0);
});
