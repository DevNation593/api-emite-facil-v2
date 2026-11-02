#!/usr/bin/env node
// Genera test/fixtures/java-e1/ con datos escritos por la API Java: arranca su jar contra
// PostgreSQL, RabbitMQ y Redis efímeros, crea por HTTP una cuenta, una sesión, una empresa y una
// API key, un emisor con su establecimiento y punto de emisión, un cliente, un producto y un
// certificado, y vuelca la base. Solo escribe en el target/ del repo Java. Uso:
//   node tools/java-dump/run.mjs --java-repo ../backend-emite-facil [--skip-build]
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callJava, fail, javaArguments, javaSource, runTool, startJavaApp } from './java-app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(resolve(here, '..', '..'), 'test', 'fixtures', 'java-e1');

/** Un .p12 RSA 2048 con KeyUsage=digitalSignature, vigente diez años, creado con el keytool de esa JVM. */
function keytoolP12(password) {
  const settings = spawnSync('java', ['-XshowSettings:properties', '-version'], { encoding: 'utf8' }).stderr;
  const javaHome = /^\s*java\.home = (.+)$/m.exec(settings)?.[1]?.trim();
  if (javaHome === undefined) fail('no se encontró java.home');
  const work = mkdtempSync(join(tmpdir(), 'java-dump-p12-'));
  try {
    const store = join(work, 'certificado.p12');
    const result = spawnSync(
      join(javaHome, 'bin', 'keytool'),
      [
        '-genkeypair', '-alias', 'firma', '-keyalg', 'RSA', '-keysize', '2048', '-sigalg', 'SHA256withRSA',
        '-dname', 'CN=Emisor de Java, O=Pruebas, C=EC', '-startdate', '-1d', '-validity', '3650',
        '-ext', 'KeyUsage=digitalSignature', '-storetype', 'PKCS12', '-keystore', store, '-storepass', password,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) fail(`keytool falló: ${result.stderr || result.stdout}`);
    return readFileSync(store);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

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

    step('crear el emisor, su establecimiento y punto de emisión, un cliente y un producto');
    const owner = { ...auth, 'X-Tenant-Id': tenant.id };
    const taxpayer = await call('emisor', 'POST', '/api/v1/taxpayers', {
      body: {
        ruc: '1799999999001',
        legalName: 'Emisor de Java S.A.',
        tradeName: 'Java',
        headOfficeAddress: 'Av. Amazonas 100, Quito',
        phone: '022345678',
        defaultEnvironment: '1',
        accountingRequired: true,
        specialTaxpayerCode: '5368',
        rimpeRegime: 'EMPRENDEDOR',
      },
      headers: owner,
      expected: 201,
    });
    const establishment = await call('establecimiento', 'POST', `/api/v1/taxpayers/${taxpayer.id}/establishments`, {
      body: { code: '001', address: 'Av. Amazonas 100, Quito' },
      headers: owner,
      expected: 201,
    });
    const emissionPoint = await call('punto de emisión', 'POST', '/api/v1/emission-points', {
      body: { establishmentId: establishment.id, code: '001' },
      headers: owner,
      expected: 201,
    });
    const customer = await call('cliente', 'POST', '/api/v1/customers', {
      body: { idType: '05', idNumber: '1712345678', name: 'María Pérez', email: 'cliente@example.test' },
      headers: owner,
      expected: 201,
    });
    const product = await call('producto', 'POST', '/api/v1/products', {
      body: { sku: 'SRV-001', name: 'Servicio de consultoría', unitPrice: '10.5', ivaRateCode: '4' },
      headers: owner,
      expected: 201,
    });

    step('cargar un certificado creado con keytool');
    // Vigente diez años: el volcado sirve para firmar mucho después de generarse.
    const certificatePassword = `java ${randomBytes(9).toString('base64url')}`;
    const p12 = keytoolP12(certificatePassword);
    const certificate = await call('certificado', 'POST', '/api/v1/certificates', {
      body: { taxpayerId: taxpayer.id, p12: p12.toString('base64'), password: certificatePassword },
      headers: owner,
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
      taxpayerId: taxpayer.id,
      certificateId: certificate.id,
      certificateFingerprint: certificate.fingerprintSha256,
      customerId: customer.id,
      productId: product.id,
      // Lo que Java respondió al crearlos: NestJS debe leer lo mismo.
      views: { taxpayer, establishment, emissionPoint, customer, product, certificate },
      env: app.secrets,
    };
    writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`[java-dump] listo: ${outDir}`);
  } finally {
    await app.stop();
  }
});
