// Arranca la API Java (su jar) contra PostgreSQL, RabbitMQ y Redis efímeros. Lo usan java-dump y
// java-probe: los dos hablan con Java por HTTP y solo escriben en el target/ del repo Java.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer } from '@testcontainers/redis';

const windows = process.platform === 'win32';
const JAR = join('target', 'einvoice-0.0.1-SNAPSHOT.jar');
// Mismas imágenes que test/support/containers.ts.
const POSTGRES_IMAGE = 'postgres:16';
const RABBIT_IMAGE = 'rabbitmq:4-management';
const REDIS_IMAGE = 'redis:7-alpine';

/** Fallo esperado de un paso: se informa con su texto, sin la pila. */
export class StepError extends Error {}

export const fail = (detail) => {
  throw new StepError(detail);
};

/**
 * Ejecuta `main(step)` informando cada paso con el prefijo. Si algo falla, nombra el paso, muestra
 * lo que devuelva `onFailure` (el final del log de Java) y deja el código de salida en 1.
 */
export async function runTool(prefix, main) {
  let current = 'arranque';
  const step = (name) => {
    current = name;
    console.log(`[${prefix}] ${name}`);
  };
  const failureHooks = [];
  try {
    await main(step, (hook) => failureHooks.push(hook));
  } catch (error) {
    console.error(
      `\n[${prefix}] FALLÓ el paso "${current}": ${error instanceof StepError ? error.message : (error?.stack ?? error)}`,
    );
    for (const hook of failureHooks) hook();
    process.exitCode = 1;
  }
}

/** Lee `--java-repo <ruta>` y `--skip-build` de los argumentos. */
export function javaArguments(argv) {
  const flag = argv.indexOf('--java-repo');
  if (flag === -1 || !argv[flag + 1]) fail('falta --java-repo <ruta>');
  const javaRepo = resolve(process.cwd(), argv[flag + 1]);
  if (!existsSync(join(javaRepo, 'pom.xml'))) fail(`${javaRepo} no es el repo Java (sin pom.xml)`);
  return { javaRepo, skipBuild: argv.includes('--skip-build') };
}

/** Commit del repo Java, si tiene cambios sin confirmar en src o pom.xml, y versión de Java. */
export function javaSource(javaRepo) {
  const git = spawnSync('git', ['-C', javaRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (git.status !== 0) fail(git.stderr.trim());
  const dirty = spawnSync('git', ['-C', javaRepo, 'status', '--porcelain', '--', 'src', 'pom.xml'], {
    encoding: 'utf8',
  }).stdout.trim();
  return {
    javaCommit: git.stdout.trim(),
    javaDirty: dirty !== '',
    javaVersion: spawnSync('java', ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0].trim(),
  };
}

// En Windows el .cmd exige shell:true y, con él, Node no entrecomilla los argumentos.
const quote = (arg) => (windows && /[\s&()^|<>]/.test(arg) ? `"${arg}"` : arg);
function runSync(command, args, options) {
  const result = windows
    ? spawnSync([command, ...args].map(quote).join(' '), { shell: true, stdio: 'inherit', ...options })
    : spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`código de salida ${result.status}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

/**
 * Empaqueta el jar (salvo `skipBuild`), levanta los contenedores y arranca Java hasta que su
 * readiness responde. `env` se suma al entorno de Java. Devuelve la URL base, el contenedor de
 * PostgreSQL, los secretos generados, `stopJava()` (detiene solo Java), `stop()` (todo) y
 * `logTail(n)` con las últimas líneas del log de Java.
 */
export async function startJavaApp({ javaRepo, skipBuild, env: extraEnv = {}, step, onFailure }) {
  const cleanups = [];
  const work = mkdtempSync(join(tmpdir(), 'java-app-'));
  const javaLog = join(work, 'java.log');
  const logTail = (lines = 40) =>
    existsSync(javaLog) ? readFileSync(javaLog, 'utf8').split('\n').slice(-lines).join('\n') : '';
  onFailure?.(() => {
    const tail = logTail();
    if (tail !== '') console.error(`últimas líneas del log de Java:\n${tail}`);
  });
  // El log sobrevive a stop(): quien informa de un fallo lo lee después de limpiar.
  process.once('exit', () => rmSync(work, { recursive: true, force: true }));
  const stop = async () => {
    while (cleanups.length > 0) await cleanups.shift()().catch(() => undefined);
  };
  try {
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

    // Valores de prueba de esta ejecución: quien llama los guarda para que NestJS arranque con ellos.
    const secrets = {
      EINVOICE_JWT_SECRET: randomBytes(48).toString('base64'),
      EINVOICE_MASTER_KEY: randomBytes(32).toString('base64'),
    };
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
      ...secrets,
      EINVOICE_WEB_URL: 'http://web.test',
      // Sin SMTP el correo queda apagado; sin ambientes no se transmite al SRI.
      SRI_ENABLED_ENVIRONMENTS: '',
      EINVOICE_WORKER_ENABLED: 'false',
      ...extraEnv,
    });
    const logStream = createWriteStream(javaLog);
    // En Windows los selectores de Java abren un socket Unix en TEMP, cuya ruta no puede pasar de
    // 108 bytes; un TEMP largo impide arrancar. target/ del repo Java es corto y ya es de Maven.
    // Inglés, como la imagen de producción (sin LANG): sin Accept-Language, Spring usa el idioma de
  // la JVM para los mensajes de validación, y el de la máquina puede ser otro.
  const jvmFlags = [`-Djdk.net.unixdomain.tmpdir=${join(javaRepo, 'target')}`, '-Duser.language=en', '-Duser.country=US'];
  const java = spawn('java', [...jvmFlags, '-jar', JAR], {
      cwd: javaRepo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    java.stdout.pipe(logStream);
    java.stderr.pipe(logStream);
    let exited = false;
    java.on('exit', () => (exited = true));
    let javaStopped = false;
    const stopJava = async () => {
      if (javaStopped) return;
      javaStopped = true;
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
    };
    cleanups.unshift(stopJava);

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
    return { base, postgres, secrets, stopJava, stop, logTail };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Petición JSON a Java que falla el paso si el estado no es el esperado. */
export async function callJava(base, name, method, path, { body, headers = {}, expected }) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Una petición que no vuelve no debe colgar la herramienta.
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (res.status !== expected) fail(`${name}: se esperaba ${expected} y llegó ${res.status} ${text}`);
  return text === '' ? undefined : JSON.parse(text);
}
