#!/usr/bin/env node
// Regenera test/golden/ con el código de la API Java (solo lectura sobre ese repo,
// salvo el target/ propio de Maven). Uso:
//   node tools/golden-generator/run.mjs --java-repo ../backend-emite-facil [--only bean-validation|certificates|xsd|calculations]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const windows = process.platform === 'win32';

let work;

function fail(step, detail) {
  if (work) rmSync(work, { recursive: true, force: true });
  console.error(`\n[golden] FALLÓ el paso "${step}"${detail ? `: ${detail}` : ''}`);
  process.exit(1);
}

// En Windows el .cmd exige shell:true y, con él, Node no entrecomilla los argumentos:
// se entrecomillan a mano y se pasa una sola línea de comando.
const quote = (arg) => (windows && /[\s&()^|<>]/.test(arg) ? `"${arg}"` : arg);

function spawnCommand(command, args, options) {
  return windows
    ? spawnSync([command, ...args].map(quote).join(' '), { shell: true, ...options })
    : spawnSync(command, args, options);
}

function run(step, command, args, options = {}) {
  console.log(`[golden] ${step}`);
  const result = spawnCommand(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
  if (result.error) fail(step, result.error.message);
  if (result.status !== 0) fail(step, `código de salida ${result.status}`);
}

function capture(step, command, args) {
  const result = spawnCommand(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) fail(step, result.error?.message ?? result.stderr.trim());
  return result.stdout.trim();
}

const argv = process.argv.slice(2);
const flag = argv.indexOf('--java-repo');
if (flag === -1 || !argv[flag + 1]) fail('argumentos', 'falta --java-repo <ruta>');
const javaRepo = resolve(process.cwd(), argv[flag + 1]);
if (!existsSync(join(javaRepo, 'pom.xml'))) fail('argumentos', `${javaRepo} no es el repo Java (sin pom.xml)`);

const onlyFlag = argv.indexOf('--only');
const only = onlyFlag === -1 ? undefined : argv[onlyFlag + 1];
if (onlyFlag !== -1 && !['bean-validation', 'certificates', 'xsd', 'calculations'].includes(only)) {
  fail('argumentos', '--only admite: bean-validation, certificates, xsd, calculations');
}

const outDir = join(projectRoot, 'test', 'golden');
work = mkdtempSync(join(tmpdir(), 'golden-generator-'));
const mvnw = join(javaRepo, windows ? 'mvnw.cmd' : 'mvnw');

try {
  const commit = capture('commit del repo Java', 'git', ['-C', javaRepo, 'rev-parse', 'HEAD']);

  run('compilar el repo Java', mvnw, ['-q', '-DskipTests', '-Djacoco.skip=true', 'test-compile'], { cwd: javaRepo });

  const classpathFile = join(work, 'classpath.txt');
  run(
    'obtener el classpath de Maven',
    mvnw,
    ['-q', 'dependency:build-classpath', '-Dmdep.includeScope=test', `-Dmdep.outputFile=${classpathFile}`],
    { cwd: javaRepo },
  );
  const classpath = [join(javaRepo, 'target', 'classes'), join(javaRepo, 'target', 'test-classes'), readFileSync(classpathFile, 'utf8').trim()].join(delimiter);

  const sources = readdirSync(join(here, 'src', 'golden'))
    .filter((f) => f.endsWith('.java'))
    .map((f) => join(here, 'src', 'golden', f));
  const classes = join(work, 'classes');
  // El classpath de Spring supera el límite de la línea de comandos de Windows: va en un @argfile
  // (con barras normales, porque dentro de las comillas la barra invertida escapa).
  const q = (value) => `"${value.replaceAll('\\', '/')}"`;
  const argfile = (name, lines) => {
    const file = join(work, name);
    writeFileSync(file, lines.join('\n'));
    return `@${file}`;
  };
  run('compilar el generador', 'javac', [
    argfile('javac.args', ['-encoding', 'UTF-8', '-d', q(classes), '-cp', q(classpath), ...sources.map(q)]),
  ]);

  run(
    'ejecutar el generador',
    'java',
    [argfile('java.args', ['-cp', q([classes, classpath].join(delimiter)), 'golden.GoldenGenerator', q(outDir), q(javaRepo), commit, ...(only ? [only] : [])])],
    { cwd: work },
  );
  console.log(`[golden] listo: ${outDir}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
