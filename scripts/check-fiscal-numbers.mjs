#!/usr/bin/env node
/*
 * Regla de lint del diseño (docs/superpowers/specs/2026-10-29-api-nestjs-design.md): en el código
 * fiscal los importes y las cantidades van en BigDecimal, nunca en `number`. Falla, con archivo y
 * línea, ante:
 *   - parseFloat o Number.parseFloat, y Math.round;
 *   - `.toFixed(` sobre algo que no sea BigDecimal o Decimal (lo decide el comprobador de tipos);
 *   - `new Decimal(` (solo src/common/big-decimal.ts crea Decimal, y no se revisa aquí);
 *   - una propiedad o un parámetro con nombre de importe (quantity, unitPrice, total…) de tipo number.
 * Una excepción se admite con `// fiscal-number-ok: <motivo>` en la línea anterior.
 *
 * Uso: node scripts/check-fiscal-numbers.mjs [directorio…]. Sin argumentos revisa src/billing,
 * src/notes, src/xml y src/catalog (los que existan).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIRS = ['src/billing', 'src/notes', 'src/xml', 'src/catalog'];
const FISCAL_NAMES = new Set([
  'quantity',
  'unitPrice',
  'discount',
  'amount',
  'subtotal',
  'total',
  'totalTax',
  'totalDiscount',
  'rate',
  'base',
  'value',
  'term',
  'taxAmount',
]);
const DECIMAL_TYPES = new Set(['BigDecimal', 'Decimal']);
const EXCEPTION = /^\s*\/\/\s*fiscal-number-ok:\s*\S/;

function tsFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return /\.ts$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}

function compilerOptions() {
  const configPath = join(ROOT, 'tsconfig.json');
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config ?? {}, ts.sys, ROOT);
  return { ...options, noEmit: true, incremental: false };
}

/** Si el tipo anotado es number, o una unión o una lista que lo incluye. */
function mentionsNumber(typeNode) {
  if (typeNode === undefined) return false;
  if (typeNode.kind === ts.SyntaxKind.NumberKeyword) return true;
  let found = false;
  ts.forEachChild(typeNode, (child) => {
    if (!found && mentionsNumber(child)) found = true;
  });
  return found;
}

function isDecimalType(checker, type) {
  const types = type.isUnion() ? type.types : [type];
  return types.every((t) => {
    const symbol = t.getSymbol() ?? t.aliasSymbol;
    return symbol !== undefined && DECIMAL_TYPES.has(symbol.getName());
  });
}

const dirs = (process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_DIRS).map((dir) => resolve(ROOT, dir));
const files = dirs.flatMap(tsFiles);
const program = ts.createProgram(files, compilerOptions());
const checker = program.getTypeChecker();
const problems = [];

for (const file of files) {
  const source = program.getSourceFile(file);
  if (source === undefined) continue;
  const lines = source.text.split(/\r?\n/);
  const report = (node, message) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    if (line > 0 && EXCEPTION.test(lines[line - 1])) return;
    problems.push(`${relative(process.cwd(), file)}:${line + 1}: ${message}`);
  };

  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === 'parseFloat' && !ts.isPropertyAccessExpression(node.parent)) {
      report(node, 'parseFloat convierte a number; use BigDecimal.of o BigDecimal.parse');
    } else if (ts.isPropertyAccessExpression(node)) {
      const owner = node.expression.getText(source);
      const name = node.name.text;
      if (owner === 'Number' && name === 'parseFloat') {
        report(node, 'Number.parseFloat convierte a number; use BigDecimal.of o BigDecimal.parse');
      } else if (owner === 'Math' && name === 'round') {
        report(node, 'Math.round redondea un number; use BigDecimal.setScale');
      } else if (name === 'toFixed' && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        // `importe?.toFixed(2)`: cuenta el tipo sin null ni undefined.
        const type = checker.getNonNullableType(checker.getTypeAtLocation(node.expression));
        if (!isDecimalType(checker, type)) {
          report(node, `toFixed sobre ${checker.typeToString(type)}; use BigDecimal.toFixed`);
        }
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Decimal') {
      report(node, 'new Decimal fuera de src/common/big-decimal.ts; use BigDecimal');
    } else if (
      (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      FISCAL_NAMES.has(node.name.text) &&
      mentionsNumber(node.type)
    ) {
      report(node.name, `${node.name.text} es un importe o una cantidad de tipo number; use BigDecimal`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} uso(s) de number en código fiscal (scripts/check-fiscal-numbers.mjs).`);
  process.exit(1);
}
