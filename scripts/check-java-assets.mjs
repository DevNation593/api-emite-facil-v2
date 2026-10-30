// Compara db/migration y resources/xsd con los activos originales del repo Java (SHA-256).
// Uso: node scripts/check-java-assets.mjs <ruta-repo-java>
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const javaRepo = process.argv[2];
if (!javaRepo) {
  console.error('Uso: node scripts/check-java-assets.mjs <ruta-repo-java>');
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  [join(resolve(javaRepo), 'src', 'main', 'resources', 'db', 'migration'), join(root, 'db', 'migration')],
  [join(resolve(javaRepo), 'src', 'main', 'resources', 'xsd'), join(root, 'resources', 'xsd')],
];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

const problems = [];
let checked = 0;
for (const [srcDir, dstDir] of pairs) {
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    problems.push(`ORIGEN AUSENTE: ${srcDir}`);
    continue;
  }
  for (const src of listFiles(srcDir)) {
    const rel = relative(srcDir, src);
    const dst = join(dstDir, rel);
    checked += 1;
    if (!existsSync(dst)) problems.push(`AUSENTE: ${relative(root, dst)}`);
    else if (sha256(src) !== sha256(dst)) problems.push(`DIFERENTE: ${relative(root, dst)}`);
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} problema(s) sobre ${checked} archivo(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`OK: ${checked} archivos idénticos al repo Java.`);
