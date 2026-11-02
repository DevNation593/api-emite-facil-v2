#!/usr/bin/env node
// Genera test/fixtures/java-e1/ con datos escritos por la API Java: arranca su jar contra
// PostgreSQL, RabbitMQ y Redis efímeros, crea por HTTP una cuenta, una sesión, una empresa y una
// API key, y vuelca la base. Solo escribe en el target/ del repo Java. Uso:
//   node tools/java-dump/run.mjs --java-repo ../backend-emite-facil [--skip-build]
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer } from '@testcontainers/redis';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');
const outDir = join(projectRoot, 'test', 'fixtures', 'java-e1');
const windows = process.platform === 'win32';
const JAR = join('target', 'einvoice-0.0.1-SNAPSHOT.jar');
// Mismas imágenes que test/support/containers.ts.
const POSTGRES_IMAGE = 'postgres:16';
const RABBIT_IMAGE = 'rabbitmq:4-management';
const REDIS_IMAGE = 'redis:7-alpine';

class StepError extends Error {}

let currentStep = 'arranque';
function step(name) {
  currentStep = name;
  console.log(`[java-dump] ${name}`);
}
const fail = (detail) => {
  throw new StepError(detail);
};

// En Windows el .cmd exige shell:true y, con él, Node no entrecomilla los argumentos.
const quote = (arg) => (windows && /[\s&()^|<>]/.test(arg) ? `"${arg}"` : arg);
function runSync(command, args, options) {
  const result = windows
    ? spawnSync([command, ...args].map(quote).join(' '), { shell: true, stdio: 'inherit', ...options })
    : spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`código de salida ${result.status}`);
  return result;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

const argv = process.argv.slice(2);
const flag = argv.indexOf('--java-repo');
const skipBuild = argv.includes('--skip-build');

const cleanups = [];
let work;
let javaLog;
try {
  step('argumentos');
  if (flag === -1 || !argv[flag + 1]) fail('falta --java-repo <ruta>');
  const javaRepo = resolve(process.cwd(), argv[flag + 1]);
  if (!existsSync(join(javaRepo, 'pom.xml'))) fail(`${javaRepo} no es el repo Java (sin pom.xml)`);
  work = mkdtempSync(join(tmpdir(), 'java-dump-'));

  step('commit del repo Java');
  const git = spawnSync('git', ['-C', javaRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (git.status !== 0) fail(git.stderr.trim());
  const javaCommit = git.stdout.trim();
  const dirty = spawnSync('git', ['-C', javaRepo, 'status', '--porcelain', '--', 'src', 'pom.xml'], {
    encoding: 'utf8',
  }).stdout.trim();

  if (!skipBuild) {
    step('empaquetar el jar de Java');
    runSync(join(javaRepo, windows ? 'mvnw.cmd' : 'mvnw'), ['-q', '-DskipTests', '-Djacoco.skip=true', 'package'], {
      cwd: javaRepo,
    });
  }
  if (!existsSync(join(javaRepo, JAR))) fail(`no existe ${JAR}; ejecute sin --skip-build`);

  step('levantar PostgreSQL, RabbitMQ y Redis');
  const [postgres, rabbit, redis] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).withDatabase('einvoice').withUsername('test').withPassword('test').start(),
    new RabbitMQContainer(RABBIT_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);
  cleanups.push(() => postgres.stop(), () => rabbit.stop(), () => redis.stop());

  // Valores de prueba de esta ejecución: van a meta.json para que NestJS arranque con ellos.
  const jwtSecret = randomBytes(48).toString('base64');
  const masterKey = randomBytes(32).toString('base64');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  step('arrancar la API Java');
  const env = { ...process.env };
  // Nada del entorno del desarrollador debe llegar a Java: ni su SMTP ni sus secretos.
  for (const name of Object.keys(env)) {
    if (/^(SPRING_|EINVOICE_|SRI_|DELIVERY_|SMTP_|DATABASE_URL|RABBITMQ_URL|REDIS_URL|SERVER_PORT)/.test(name)) {
      delete env[name];
    }
  }
  Object.assign(env, {
    PORT: String(port),
    DATABASE_URL: postgres.getConnectionUri(),
    RABBITMQ_URL: rabbit.getAmqpUrl(),
    REDIS_URL: redis.getConnectionUrl(),
    EINVOICE_MASTER_KEY: masterKey,
    EINVOICE_JWT_SECRET: jwtSecret,
    EINVOICE_WEB_URL: 'http://web.test',
    // Sin SMTP el correo queda apagado; sin ambientes no se transmite al SRI.
    SRI_ENABLED_ENVIRONMENTS: '',
    EINVOICE_WORKER_ENABLED: 'false',
    // La sesión del dump no caduca: la prueba de renovación sigue valiendo con el tiempo.
    EINVOICE_AUTH_SESSIONTTL: '87600h',
  });
  javaLog = join(work, 'java.log');
  const logStream = createWriteStream(javaLog);
  // En Windows los selectores de Java abren un socket Unix en TEMP, cuya ruta no puede pasar de
  // 108 bytes; un TEMP largo impide arrancar. target/ del repo Java es corto y ya es de Maven.
  const java = spawn('java', [`-Djdk.net.unixdomain.tmpdir=${join(javaRepo, 'target')}`, '-jar', JAR], {
    cwd: javaRepo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  java.stdout.pipe(logStream);
  java.stderr.pipe(logStream);
  let exited = false;
  java.on('exit', () => (exited = true));
  cleanups.unshift(async () => {
    if (!exited) {
      const done = new Promise((resolve) => java.once('exit', resolve));
      // En Windows "java" suele ser el lanzador de Oracle (javapath), que arranca la JVM como hija:
      // matar solo el lanzador la deja viva con las tuberías abiertas y Node no termina nunca.
      if (windows) spawnSync('taskkill', ['/pid', String(java.pid), '/T', '/F'], { stdio: 'ignore' });
      else java.kill();
      await done;
    }
    java.stdout.destroy();
    java.stderr.destroy();
    await new Promise((resolve) => logStream.end(resolve));
  });

  step('esperar a que Java esté lista');
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (exited) fail('Java terminó antes de estar lista');
    if (Date.now() > deadline) fail('Java no estuvo lista en 180 s');
    const ready = await fetch(`${base}/actuator/health/readiness`, { signal: AbortSignal.timeout(5_000) }).then(
      (res) => res.status === 200,
      () => false,
    );
    if (ready) break;
    await new Promise((done) => setTimeout(done, 1_000));
  }

  async function call(name, method, path, { body, headers = {}, expected }) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Una petición que no vuelve no debe colgar el generador.
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status !== expected) fail(`${name}: se esperaba ${expected} y llegó ${res.status} ${text}`);
    return text === '' ? undefined : JSON.parse(text);
  }

  step('crear la cuenta, la sesión, la empresa y la API key');
  // En mayúsculas: Java guarda el correo normalizado y NestJS debe encontrarlo igual. Espacios no:
  // @Email los rechaza antes de normalizar.
  const email = `java-${randomUUID().slice(0, 8)}@example.test`;
  const password = `java ${randomBytes(9).toString('base64url')}`;
  await call('registro', 'POST', '/api/v1/auth/register', {
    body: { email: email.toUpperCase(), password },
    expected: 202,
  });
  const tokens = await call('ingreso', 'POST', '/api/v1/auth/login', { body: { email, password }, expected: 200 });
  const auth = { Authorization: `Bearer ${tokens.accessToken}` };
  const tenant = await call('empresa', 'POST', '/api/v1/tenants', {
    body: { name: 'Empresa creada por Java' },
    headers: auth,
    expected: 201,
  });
  const apiKey = await call('API key', 'POST', '/api/v1/api-keys', {
    body: { name: 'ERP de Java' },
    headers: { ...auth, 'X-Tenant-Id': tenant.id },
    expected: 201,
  });

  step('comprobar los datos en Java');
  const viaKey = await call('empresa con la API key', 'GET', '/api/v1/tenants/current', {
    headers: { 'X-Api-Key': apiKey.key },
    expected: 200,
  });
  if (viaKey.id !== tenant.id) fail('la API key no resuelve su empresa');

  // Se detiene Java antes de volcar: nada más escribe en la base.
  step('detener Java');
  await cleanups.shift()();

  step('volcar la base');
  const dump = await postgres.exec(['pg_dump', '--no-owner', '--no-privileges', '-U', 'test', 'einvoice']);
  if (dump.exitCode !== 0) fail(dump.stderr || dump.output);
  const claims = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64url').toString('utf8'));

  step('escribir los fixtures');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'dump.sql'), dump.stdout.replaceAll('\r\n', '\n'));
  const meta = {
    // Valores de prueba generados en esta ejecución; ninguno sirve fuera de estos fixtures.
    source: {
      javaCommit,
      javaDirty: dirty !== '',
      javaVersion: spawnSync('java', ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0].trim(),
      generatedAt: new Date().toISOString(),
    },
    email,
    password,
    userId: claims.sub,
    tenantId: tenant.id,
    tenantName: tenant.name,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessTokenIat: claims.iat,
    accessTokenExp: claims.exp,
    apiKey: apiKey.key,
    apiKeyId: apiKey.id,
    env: { EINVOICE_JWT_SECRET: jwtSecret, EINVOICE_MASTER_KEY: masterKey },
  };
  writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`[java-dump] listo: ${outDir}`);
} catch (error) {
  console.error(
    `\n[java-dump] FALLÓ el paso "${currentStep}": ${error instanceof StepError ? error.message : error?.stack ?? error}`,
  );
  if (javaLog && existsSync(javaLog)) {
    console.error('[java-dump] últimas líneas del log de Java:');
    console.error(readFileSync(javaLog, 'utf8').split('\n').slice(-40).join('\n'));
  }
  process.exitCode = 1;
} finally {
  for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  if (work) rmSync(work, { recursive: true, force: true });
}
