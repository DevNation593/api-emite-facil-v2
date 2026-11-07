import {
  parseDatabaseUrl,
  parseRabbitUrl,
  type DatabaseConnection,
  type RabbitConnection,
} from './connection-urls.js';
import { parseDuration } from './durations.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  port: number;
  database: DatabaseConnection & { poolSize: number; poolMinIdle: number };
  rabbit: RabbitConnection;
  redis: { url: string; timeoutMs: number };
  workerEnabled: boolean;
  logFormat: 'text' | 'json';
  masterKey: Buffer;
  auth: {
    jwtSecret: string;
    webUrl: URL;
    accessTokenTtlMs: number;
    sessionTtlMs: number;
    verificationTtlMs: number;
    resetTtlMs: number;
    maxLoginFailures: number;
    lockoutMs: number;
    publicRequestsPerMinute: number;
    trustedProxyHops: number;
  };
  mail: {
    host: string | null;
    port: number;
    user: string | null;
    password: string | null;
    startTls: boolean;
    from: string | null;
  };
  metricsToken: string | null;
  rateLimit: { requestsPerMinute: number; writesPerMinute: number };
  sri: { enabledEnvironments: Array<'1' | '2'> };
  providerRuc: string | null;
  /** Monto máximo de un comprobante a consumidor final, como decimal en texto (EINVOICE_INVOICE_FINAL_CONSUMER_LIMIT). */
  finalConsumerLimit: string;
}

const MASTER_KEY_BYTES = 32;
const MIN_JWT_SECRET_BYTES = 32;
const MIN_METRICS_TOKEN_LENGTH = 24;

/** Emisor y audiencia de los tokens de acceso: los emite y los valida esta misma API. */
export const TOKEN_ISSUER = 'einvoice-api';
export const TOKEN_AUDIENCE = 'einvoice-api';

// Plazos de application.yml (einvoice.auth.*); en Java no se leen del entorno.
const ACCESS_TOKEN_TTL_MS = parseDuration('15m');
const SESSION_TTL_MS = parseDuration('12h');
const VERIFICATION_TTL_MS = parseDuration('24h');
const RESET_TTL_MS = parseDuration('1h');
const MAX_LOGIN_FAILURES = 5;
const LOCKOUT_MS = parseDuration('15m');
const PUBLIC_REQUESTS_PER_MINUTE = 20;

/** Monto máximo por defecto de un comprobante a consumidor final (einvoice.invoice.final-consumer-limit). */
export const DEFAULT_FINAL_CONSUMER_LIMIT = '50.00';

/**
 * Plazo tras el cual un comprobante reservado que nadie procesó vuelve a la cola
 * (einvoice.worker.redelivery-lease); como los de einvoice.auth.*, no se lee del entorno.
 */
export const REDELIVERY_LEASE_MS = parseDuration('5m');

/** Enlace de la web con un código de un solo uso: el código va en el fragmento, que no viaja al servidor. */
export function authLink(webUrl: URL, path: string, token: string): string {
  return `${webUrl.href.replace(/\/+$/, '')}${path}#token=${token}`;
}

function requirePositive(name: string, value: number): void {
  if (!(value > 0)) throw new Error(`einvoice.auth.${name} debe ser positivo`);
}

/** Valor de una variable; una variable vacía cuenta como ausente (como `${X:}` en Spring). */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string, hint: string): string {
  const value = read(env, name);
  if (value === undefined) throw new Error(`Falta ${name}: ${hint}`);
  return value;
}

function loadMasterKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = required(
    env,
    'EINVOICE_MASTER_KEY',
    'es la clave maestra (32 bytes en Base64: openssl rand -base64 32)',
  );
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new Error('EINVOICE_MASTER_KEY no es Base64 válido');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error('EINVOICE_MASTER_KEY debe decodificar a 32 bytes');
  }
  return key;
}

function loadTrustedProxyHops(env: NodeJS.ProcessEnv): number {
  const raw = read(env, 'EINVOICE_TRUSTED_PROXY_HOPS');
  const hops = raw === undefined ? 1 : /^-?\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(hops) || hops < 1) {
    throw new Error(
      'EINVOICE_TRUSTED_PROXY_HOPS debe ser al menos 1: cuántos proxies de confianza añaden su entrada a X-Forwarded-For (2 en Cloud Run, contando la web)',
    );
  }
  return hops;
}

function loadFinalConsumerLimit(env: NodeJS.ProcessEnv): string {
  const raw = read(env, 'EINVOICE_INVOICE_FINAL_CONSUMER_LIMIT');
  if (raw === undefined) return DEFAULT_FINAL_CONSUMER_LIMIT;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(
      'EINVOICE_INVOICE_FINAL_CONSUMER_LIMIT debe ser un monto decimal no negativo con hasta 2 decimales (por ejemplo 50.00)',
    );
  }
  return raw;
}

function loadMail(env: NodeJS.ProcessEnv): AppConfig['mail'] {
  const password = env.SPRING_MAIL_PASSWORD;
  return {
    host: read(env, 'SPRING_MAIL_HOST') ?? null,
    port: integer(env, 'SPRING_MAIL_PORT', 25, 1, 65_535),
    user: read(env, 'SPRING_MAIL_USERNAME') ?? null,
    password: password === undefined || password === '' ? null : password,
    startTls: read(env, 'SMTP_STARTTLS') !== 'false',
    from: read(env, 'DELIVERY_EMAIL_FROM') ?? null,
  };
}

function loadAuth(env: NodeJS.ProcessEnv): AppConfig['auth'] {
  const jwtSecret = env.EINVOICE_JWT_SECRET ?? '';
  if (Buffer.byteLength(jwtSecret, 'utf8') < MIN_JWT_SECRET_BYTES) {
    throw new Error(
      `Falta EINVOICE_JWT_SECRET o tiene menos de ${MIN_JWT_SECRET_BYTES} bytes: es la clave con la que la API firma sus tokens (openssl rand -base64 48)`,
    );
  }
  const raw = read(env, 'EINVOICE_WEB_URL') ?? '';
  let webUrl: URL | undefined;
  try {
    webUrl = new URL(raw.replace(/\/+$/, ''));
  } catch {
    webUrl = undefined;
  }
  if (
    !webUrl ||
    webUrl.hostname === '' ||
    (webUrl.protocol !== 'http:' && webUrl.protocol !== 'https:')
  ) {
    throw new Error(
      'Falta EINVOICE_WEB_URL o no es una dirección http(s) absoluta: es la dirección de la aplicación web, a la que llevan los enlaces de los correos',
    );
  }
  if (raw.includes('?') || raw.includes('#')) {
    throw new Error('EINVOICE_WEB_URL no debe llevar parámetros ni fragmento');
  }
  const auth: AppConfig['auth'] = {
    jwtSecret,
    webUrl,
    accessTokenTtlMs: ACCESS_TOKEN_TTL_MS,
    sessionTtlMs: SESSION_TTL_MS,
    verificationTtlMs: VERIFICATION_TTL_MS,
    resetTtlMs: RESET_TTL_MS,
    maxLoginFailures: MAX_LOGIN_FAILURES,
    lockoutMs: LOCKOUT_MS,
    publicRequestsPerMinute: PUBLIC_REQUESTS_PER_MINUTE,
    trustedProxyHops: loadTrustedProxyHops(env),
  };
  requirePositive('access-token-ttl', auth.accessTokenTtlMs);
  requirePositive('session-ttl', auth.sessionTtlMs);
  requirePositive('verification-ttl', auth.verificationTtlMs);
  requirePositive('reset-ttl', auth.resetTtlMs);
  requirePositive('lockout', auth.lockoutMs);
  return auth;
}

function loadMetricsToken(env: NodeJS.ProcessEnv): string | null {
  const token = read(env, 'EINVOICE_METRICS_TOKEN');
  if (token === undefined) return null;
  if (token.length < MIN_METRICS_TOKEN_LENGTH) {
    throw new Error(
      `EINVOICE_METRICS_TOKEN debe tener al menos ${MIN_METRICS_TOKEN_LENGTH} caracteres aleatorios`,
    );
  }
  return token;
}

function loadSriEnvironments(env: NodeJS.ProcessEnv): Array<'1' | '2'> {
  const codes = (read(env, 'SRI_ENABLED_ENVIRONMENTS') ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code !== '');
  const enabled = new Set<'1' | '2'>();
  for (const code of codes) {
    if (code !== '1' && code !== '2') {
      throw new Error(
        'SRI_ENABLED_ENVIRONMENTS solo admite los ambientes 1 (pruebas) y 2 (producción)',
      );
    }
    enabled.add(code);
  }
  return (['1', '2'] as const).filter((code) => enabled.has(code));
}

function loadRedisTimeout(env: NodeJS.ProcessEnv): number {
  try {
    return parseDuration(read(env, 'REDIS_TIMEOUT') ?? '500ms');
  } catch {
    throw new Error('REDIS_TIMEOUT no es una duración válida (por ejemplo 500ms)');
  }
}

/**
 * Valida el entorno y lo convierte en configuración tipada. No abre ninguna conexión:
 * la aplicación debe poder arrancar sin infraestructura (pg, Redis y RabbitMQ conectan
 * bajo demanda).
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const database = parseDatabaseUrl(
    required(env, 'DATABASE_URL', 'postgresql://usuario:contraseña@host:puerto/base'),
  );
  const rabbit = parseRabbitUrl(
    required(env, 'RABBITMQ_URL', 'amqp://usuario:contraseña@host:puerto'),
  );

  const enabledEnvironments = loadSriEnvironments(env);
  const providerRuc = read(env, 'EINVOICE_PROVIDER_RUC') ?? null;
  if (providerRuc !== null && !/^[0-9]{13}$/.test(providerRuc)) {
    throw new Error('EINVOICE_PROVIDER_RUC debe ser un RUC de 13 dígitos');
  }
  if (enabledEnvironments.includes('2') && providerRuc === null) {
    throw new Error(
      'EINVOICE_PROVIDER_RUC es obligatorio cuando SRI_ENABLED_ENVIRONMENTS incluye 2 (Resolución NAC-DGERCGC26-00000027)',
    );
  }

  const defaultPort = integer(env, 'PORT', 8080, 1, 65_535);
  return {
    port: integer(env, 'SERVER_PORT', defaultPort, 1, 65_535),
    database: {
      ...database,
      poolSize: integer(env, 'DB_POOL_SIZE', 5, 1),
      poolMinIdle: integer(env, 'DB_POOL_MIN_IDLE', 1, 0),
    },
    rabbit,
    redis: {
      url: read(env, 'REDIS_URL') ?? 'redis://localhost:6379',
      timeoutMs: loadRedisTimeout(env),
    },
    workerEnabled: read(env, 'EINVOICE_WORKER_ENABLED') !== 'false',
    logFormat: read(env, 'LOGGING_STRUCTURED_FORMAT_CONSOLE') ? 'json' : 'text',
    masterKey: loadMasterKey(env),
    auth: loadAuth(env),
    mail: loadMail(env),
    metricsToken: loadMetricsToken(env),
    rateLimit: {
      requestsPerMinute: integer(env, 'EINVOICE_RATE_LIMIT_REQUESTS', 1200, 1),
      writesPerMinute: integer(env, 'EINVOICE_RATE_LIMIT_WRITES', 300, 1),
    },
    sri: { enabledEnvironments },
    providerRuc,
    finalConsumerLimit: loadFinalConsumerLimit(env),
  };
}
