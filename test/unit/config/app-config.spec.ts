import { authLink, loadConfig } from '../../../src/config/app-config.js';

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const JWT_SECRET = 'x'.repeat(32);

const base = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgresql://app:secreta@localhost:5432/einvoice',
  RABBITMQ_URL: 'amqp://einvoice:secreta@localhost:5672',
  EINVOICE_MASTER_KEY: MASTER_KEY,
  EINVOICE_JWT_SECRET: JWT_SECRET,
  EINVOICE_WEB_URL: 'http://localhost:3000',
});

function without(name: string): NodeJS.ProcessEnv {
  const env = base();
  delete env[name];
  return env;
}

function messageOf(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('se esperaba un error');
}

describe('loadConfig', () => {
  it('aplica los valores por defecto con un entorno mínimo válido', () => {
    const config = loadConfig(base());
    expect(config.port).toBe(8080);
    expect(config.database).toMatchObject({
      host: 'localhost',
      poolSize: 5,
      poolMinIdle: 1,
    });
    expect(config.rabbit).toMatchObject({
      host: 'localhost',
      port: 5672,
      vhost: '/',
      tls: false,
    });
    expect(config.redis).toEqual({ url: 'redis://localhost:6379', timeoutMs: 500 });
    expect(config.workerEnabled).toBe(true);
    expect(config.logFormat).toBe('text');
    expect(config.masterKey.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(config.auth.jwtSecret).toBe(JWT_SECRET);
    expect(config.auth.webUrl.href).toBe('http://localhost:3000/');
    expect(config.metricsToken).toBeNull();
    expect(config.rateLimit).toEqual({ requestsPerMinute: 1200, writesPerMinute: 300 });
    expect(config.sri.enabledEnvironments).toEqual([]);
    expect(config.providerRuc).toBeNull();
  });

  it('lee las variables opcionales', () => {
    const config = loadConfig({
      ...base(),
      DB_POOL_SIZE: '9',
      DB_POOL_MIN_IDLE: '2',
      REDIS_URL: 'rediss://:clave@cache:6380',
      REDIS_TIMEOUT: '2s',
      LOGGING_STRUCTURED_FORMAT_CONSOLE: 'logstash',
      EINVOICE_METRICS_TOKEN: ` ${'a'.repeat(24)} `,
      EINVOICE_RATE_LIMIT_REQUESTS: '10',
      EINVOICE_RATE_LIMIT_WRITES: '5',
      SRI_ENABLED_ENVIRONMENTS: '1',
    });
    expect(config.database).toMatchObject({ poolSize: 9, poolMinIdle: 2 });
    expect(config.redis).toEqual({ url: 'rediss://:clave@cache:6380', timeoutMs: 2000 });
    expect(config.logFormat).toBe('json');
    expect(config.metricsToken).toBe('a'.repeat(24));
    expect(config.rateLimit).toEqual({ requestsPerMinute: 10, writesPerMinute: 5 });
    expect(config.sri.enabledEnvironments).toEqual(['1']);
  });

  it('SERVER_PORT gana a PORT', () => {
    expect(loadConfig({ ...base(), PORT: '9000' }).port).toBe(9000);
    expect(loadConfig({ ...base(), PORT: '9000', SERVER_PORT: '9100' }).port).toBe(9100);
  });

  it('EINVOICE_WORKER_ENABLED=false desactiva el worker', () => {
    expect(loadConfig({ ...base(), EINVOICE_WORKER_ENABLED: 'false' }).workerEnabled).toBe(false);
    expect(loadConfig({ ...base(), EINVOICE_WORKER_ENABLED: 'true' }).workerEnabled).toBe(true);
  });

  it('EINVOICE_MASTER_KEY ausente, no Base64 o de 16 bytes es un error que nombra la variable', () => {
    for (const env of [
      without('EINVOICE_MASTER_KEY'),
      { ...base(), EINVOICE_MASTER_KEY: 'no es base64!!' },
      { ...base(), EINVOICE_MASTER_KEY: Buffer.alloc(16, 1).toString('base64') },
    ]) {
      expect(messageOf(env)).toContain('EINVOICE_MASTER_KEY');
    }
  });

  it('EINVOICE_JWT_SECRET de 31 bytes es un error; de 32 vale', () => {
    expect(messageOf({ ...base(), EINVOICE_JWT_SECRET: 'x'.repeat(31) })).toContain(
      'EINVOICE_JWT_SECRET',
    );
    expect(() => loadConfig({ ...base(), EINVOICE_JWT_SECRET: 'x'.repeat(32) })).not.toThrow();
    // Cuenta bytes UTF-8, no caracteres: 16 caracteres de 2 bytes.
    expect(() => loadConfig({ ...base(), EINVOICE_JWT_SECRET: 'ñ'.repeat(16) })).not.toThrow();
  });

  it('EINVOICE_WEB_URL debe ser http(s) absoluta sin parámetros ni fragmento', () => {
    for (const env of [
      without('EINVOICE_WEB_URL'),
      { ...base(), EINVOICE_WEB_URL: 'ftp://web' },
      { ...base(), EINVOICE_WEB_URL: 'localhost:3000' },
      { ...base(), EINVOICE_WEB_URL: 'http://web/?a=1' },
      { ...base(), EINVOICE_WEB_URL: 'http://web/#x' },
    ]) {
      expect(messageOf(env)).toContain('EINVOICE_WEB_URL');
    }
  });

  it('EINVOICE_METRICS_TOKEN corto es un error', () => {
    expect(messageOf({ ...base(), EINVOICE_METRICS_TOKEN: 'corto' })).toContain(
      'EINVOICE_METRICS_TOKEN',
    );
  });

  it('SRI_ENABLED_ENVIRONMENTS=1,2 sin EINVOICE_PROVIDER_RUC es un error', () => {
    const env = { ...base(), SRI_ENABLED_ENVIRONMENTS: '1,2' };
    expect(messageOf(env)).toContain('EINVOICE_PROVIDER_RUC');
    const config = loadConfig({ ...env, EINVOICE_PROVIDER_RUC: '1790012345001' });
    expect(config.sri.enabledEnvironments).toEqual(['1', '2']);
    expect(config.providerRuc).toBe('1790012345001');
  });

  it('EINVOICE_PROVIDER_RUC debe tener 13 dígitos aunque no haya ambientes SRI', () => {
    expect(messageOf({ ...base(), EINVOICE_PROVIDER_RUC: 'abc' })).toContain(
      'EINVOICE_PROVIDER_RUC',
    );
    expect(
      messageOf({
        ...base(),
        SRI_ENABLED_ENVIRONMENTS: '1,2',
        EINVOICE_PROVIDER_RUC: '123456789012',
      }),
    ).toContain('13 dígitos');
    expect(
      loadConfig({ ...base(), EINVOICE_PROVIDER_RUC: '1790012345001' }).providerRuc,
    ).toBe('1790012345001');
    expect(loadConfig({ ...base(), EINVOICE_PROVIDER_RUC: '   ' }).providerRuc).toBeNull();
  });

  it('SRI_ENABLED_ENVIRONMENTS rechaza ambientes desconocidos', () => {
    expect(messageOf({ ...base(), SRI_ENABLED_ENVIRONMENTS: '3' })).toContain(
      'SRI_ENABLED_ENVIRONMENTS',
    );
  });

  it('DATABASE_URL y RABBITMQ_URL son obligatorias y sus errores no filtran la contraseña', () => {
    expect(messageOf(without('DATABASE_URL'))).toContain('DATABASE_URL');
    const message = messageOf({ ...base(), RABBITMQ_URL: 'http://u:secreta@mq' });
    expect(message).toContain('RABBITMQ_URL');
    expect(message).not.toContain('secreta');
  });

  it('los enteros inválidos nombran la variable', () => {
    expect(messageOf({ ...base(), DB_POOL_SIZE: '0' })).toContain('DB_POOL_SIZE');
    expect(messageOf({ ...base(), SERVER_PORT: 'abc' })).toContain('SERVER_PORT');
  });
});

describe('configuración de autenticación y correo', () => {
  it('los plazos y límites son los de application.yml', () => {
    const { auth } = loadConfig(base());
    expect(auth).toMatchObject({
      accessTokenTtlMs: 15 * 60_000,
      sessionTtlMs: 12 * 3_600_000,
      verificationTtlMs: 24 * 3_600_000,
      resetTtlMs: 3_600_000,
      maxLoginFailures: 5,
      lockoutMs: 15 * 60_000,
      publicRequestsPerMinute: 20,
      trustedProxyHops: 1,
    });
  });

  it('EINVOICE_TRUSTED_PROXY_HOPS se lee y debe ser al menos 1', () => {
    expect(loadConfig({ ...base(), EINVOICE_TRUSTED_PROXY_HOPS: '2' }).auth.trustedProxyHops).toBe(
      2,
    );
    for (const bad of ['0', '-1', 'dos']) {
      expect(messageOf({ ...base(), EINVOICE_TRUSTED_PROXY_HOPS: bad })).toContain(
        'EINVOICE_TRUSTED_PROXY_HOPS debe ser al menos 1',
      );
    }
  });

  it('la clave de firma cuenta bytes, no caracteres', () => {
    expect(() => loadConfig({ ...base(), EINVOICE_JWT_SECRET: 'ñ'.repeat(16) })).not.toThrow();
    expect(messageOf({ ...base(), EINVOICE_JWT_SECRET: 'ñ'.repeat(15) })).toContain(
      'EINVOICE_JWT_SECRET',
    );
  });

  it('la dirección de la web debe ser http(s) absoluta y sin parámetros', () => {
    for (const url of [
      '/relativa',
      'ftp://app.example.com',
      'https://app.example.com/?a=1',
      'https://app.example.com/#x',
    ]) {
      expect(messageOf({ ...base(), EINVOICE_WEB_URL: url })).toContain('EINVOICE_WEB_URL');
    }
  });

  it('authLink pone el código en el fragmento y quita la barra final', () => {
    const auth = loadConfig({
      ...base(),
      EINVOICE_WEB_URL: 'https://app.example.com/facturas/',
    }).auth;
    expect(authLink(auth.webUrl, '/verify-email', 'abc')).toBe(
      'https://app.example.com/facturas/verify-email#token=abc',
    );
    expect(authLink(new URL('http://localhost:3000'), '/reset', 't')).toBe(
      'http://localhost:3000/reset#token=t',
    );
  });

  it('el correo sin configurar da nulos, puerto 25 y STARTTLS activo', () => {
    expect(loadConfig(base()).mail).toEqual({
      host: null,
      port: 25,
      user: null,
      password: null,
      startTls: true,
      from: null,
    });
  });

  it('el correo lee las variables de Spring', () => {
    const mail = loadConfig({
      ...base(),
      SPRING_MAIL_HOST: 'smtp.example.com',
      SPRING_MAIL_PORT: '587',
      SPRING_MAIL_USERNAME: 'apikey',
      SPRING_MAIL_PASSWORD: 'secreta',
      SMTP_STARTTLS: 'false',
      DELIVERY_EMAIL_FROM: 'no-responder@example.com',
    }).mail;
    expect(mail).toEqual({
      host: 'smtp.example.com',
      port: 587,
      user: 'apikey',
      password: 'secreta',
      startTls: false,
      from: 'no-responder@example.com',
    });
  });
});
