#!/usr/bin/env node
// Genera test/fixtures/java-e1/ con datos escritos por la API Java: arranca su jar contra
// PostgreSQL, RabbitMQ y Redis efímeros, crea por HTTP una cuenta, una sesión, una empresa y una
// API key, y vuelca la base. Solo escribe en el target/ del repo Java. Uso:
//   node tools/java-dump/run.mjs --java-repo ../backend-emite-facil [--skip-build]
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callJava, fail, javaArguments, javaSource, runTool, startJavaApp } from './java-app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(resolve(here, '..', '..'), 'test', 'fixtures', 'java-e1');

await runTool('java-dump', async (step, onFailure) => {
  step('argumentos');
  const { javaRepo, skipBuild } = javaArguments(process.argv.slice(2));
  step('commit del repo Java');
  const source = javaSource(javaRepo);

  const app = await startJavaApp({
    javaRepo,
    skipBuild,
    step,
    onFailure,
    // La sesión del dump no caduca: la prueba de renovación sigue valiendo con el tiempo.
    env: { EINVOICE_AUTH_SESSIONTTL: '87600h' },
  });
  try {
    const call = (...args) => callJava(app.base, ...args);

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
    await app.stopJava();

    step('volcar la base');
    const dump = await app.postgres.exec(['pg_dump', '--no-owner', '--no-privileges', '-U', 'test', 'einvoice']);
    if (dump.exitCode !== 0) fail(dump.stderr || dump.output);
    const claims = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64url').toString('utf8'));

    step('escribir los fixtures');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'dump.sql'), dump.stdout.replaceAll('\r\n', '\n'));
    const meta = {
      // Valores de prueba generados en esta ejecución; ninguno sirve fuera de estos fixtures.
      source: { ...source, generatedAt: new Date().toISOString() },
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
      env: app.secrets,
    };
    writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`[java-dump] listo: ${outDir}`);
  } finally {
    await app.stop();
  }
});
