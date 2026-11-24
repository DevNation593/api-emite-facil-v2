import { parseDuration } from '../config/durations.js';
import { codeOf, type SriEnvironment } from './sri-environment.js';

/*
 * Configuración de la conexión con el SRI, como sri/SriProperties.java. Las direcciones solo salen de aquí
 * —ningún cliente de la API las envía— y se validan al arrancar: HTTPS y un host oficial, salvo que se
 * permitan expresamente direcciones propias (pruebas con un SRI simulado).
 */

export interface SriEndpoints {
  reception: URL;
  authorization: URL;
}

export interface SriConfig {
  enabledEnvironments: Array<'1' | '2'>;
  allowCustomEndpoints: boolean;
  endpoints: Record<SriEnvironment, SriEndpoints>;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  authorizationDelayMs: number;
  retryBackoffMs: number;
  retryMaxBackoffMs: number;
  retryMaxAttempts: number;
}

interface EndpointsInput {
  reception: string | null;
  authorization: string | null;
}

/** Lo que se valida: las direcciones aún como texto (o nulas), como llegan a Spring. */
export interface SriConfigInput {
  enabledEnvironments: readonly string[] | null;
  allowCustomEndpoints: boolean;
  test: EndpointsInput | null;
  production: EndpointsInput | null;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  authorizationDelayMs: number;
  retryBackoffMs: number;
  retryMaxBackoffMs: number;
  retryMaxAttempts: number;
}

const OFFICIAL_HOSTS = new Set(['celcer.sri.gob.ec', 'cel.sri.gob.ec']);

/** Margen que se añade a los tiempos de espera para dar por muerto un envío sin respuesta. */
const LEASE_MARGIN_MS = 30_000;

/** Servicios off-line oficiales (ficha técnica v2.34, numeral 7.2), los de application.yml. */
export const OFFICIAL_ENDPOINTS = {
  test: {
    reception: 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    authorization: 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
  },
  production: {
    reception: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    authorization: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
  },
} as const;

function checkUrl(name: string, raw: string | null, allowCustom: boolean): URL {
  const property = `einvoice.sri.${name}`;
  let url: URL | null = null;
  try {
    url = raw === null ? null : new URL(raw);
  } catch {
    url = null;
  }
  if (url === null || url.hostname === '') throw new Error(`${property} debe ser una dirección absoluta`);
  const https = url.protocol === 'https:';
  if (allowCustom) {
    if (!https && url.protocol !== 'http:') throw new Error(`${property} debe ser una dirección http o https`);
    return url;
  }
  if (!https || !OFFICIAL_HOSTS.has(url.hostname.toLowerCase()) || url.username !== '' || url.password !== '') {
    throw new Error(
      `${property} debe ser una dirección https de un host oficial del SRI` +
        ' (o activar einvoice.sri.allow-custom-endpoints para un SRI simulado)',
    );
  }
  return url;
}

function checkEndpoints(name: string, endpoints: EndpointsInput | null, allowCustom: boolean): SriEndpoints {
  if (endpoints === null) throw new Error(`Faltan las direcciones einvoice.sri.${name}`);
  return {
    reception: checkUrl(`${name}.reception`, endpoints.reception, allowCustom),
    authorization: checkUrl(`${name}.authorization`, endpoints.authorization, allowCustom),
  };
}

function requirePositive(name: string, value: number): void {
  if (!(value > 0)) throw new Error(`einvoice.sri.${name} debe ser mayor que cero`);
}

/** Valida como el constructor de SriProperties y devuelve la configuración. */
export function createSriConfig(input: SriConfigInput): SriConfig {
  const enabled = new Set<string>(input.enabledEnvironments ?? []);
  for (const code of enabled) {
    if (code !== '1' && code !== '2') {
      throw new Error('einvoice.sri.enabled-environments solo admite los ambientes 1 (pruebas) y 2 (producción)');
    }
  }
  const test = checkEndpoints('test', input.test, input.allowCustomEndpoints);
  const production = checkEndpoints('production', input.production, input.allowCustomEndpoints);
  requirePositive('connect-timeout', input.connectTimeoutMs);
  requirePositive('read-timeout', input.readTimeoutMs);
  requirePositive('retry-backoff', input.retryBackoffMs);
  requirePositive('retry-max-backoff', input.retryMaxBackoffMs);
  if (!(input.authorizationDelayMs >= 0)) throw new Error('einvoice.sri.authorization-delay no puede ser negativo');
  if (!(input.retryMaxAttempts >= 1)) throw new Error('einvoice.sri.retry-max-attempts debe ser al menos 1');
  return {
    enabledEnvironments: (['1', '2'] as const).filter((code) => enabled.has(code)),
    allowCustomEndpoints: input.allowCustomEndpoints,
    endpoints: { TEST: test, PRODUCTION: production },
    connectTimeoutMs: input.connectTimeoutMs,
    readTimeoutMs: input.readTimeoutMs,
    authorizationDelayMs: input.authorizationDelayMs,
    retryBackoffMs: input.retryBackoffMs,
    retryMaxBackoffMs: input.retryMaxBackoffMs,
    retryMaxAttempts: input.retryMaxAttempts,
  };
}

export function isEnabled(config: SriConfig, environment: SriEnvironment): boolean {
  return config.enabledEnvironments.includes(codeOf(environment));
}

/** Tiempo tras el cual un envío que no dejó resultado se da por muerto y hay que reconciliarlo. */
export function sendLeaseMs(config: SriConfig): number {
  return config.connectTimeoutMs + config.readTimeoutMs + LEASE_MARGIN_MS;
}

/** Valor de una variable; una vacía cuenta como ausente (como `${X:}` en Spring). */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function duration(env: NodeJS.ProcessEnv, name: string, fallback: string): number {
  const raw = read(env, name) ?? fallback;
  try {
    return parseDuration(raw);
  } catch {
    throw new Error(`${name} no es una duración válida (por ejemplo ${fallback})`);
  }
}

/**
 * Lee la configuración del entorno con los nombres de application.yml (`SRI_*`) y los relajados de Spring
 * para lo que allí no tiene variable propia (`EINVOICE_SRI_*`). Los ambientes habilitados los lee
 * `loadConfig`, que ya validaba SRI_ENABLED_ENVIRONMENTS con su propio mensaje.
 */
export function loadSriConfig(env: NodeJS.ProcessEnv, enabledEnvironments: readonly string[]): SriConfig {
  const custom = read(env, 'EINVOICE_SRI_ALLOW_CUSTOM_ENDPOINTS') ?? 'false';
  if (!/^(true|false)$/i.test(custom)) throw new Error('EINVOICE_SRI_ALLOW_CUSTOM_ENDPOINTS debe ser true o false');
  const retryMax = read(env, 'SRI_RETRY_MAX') ?? '40';
  if (!/^-?\d+$/.test(retryMax) || !Number.isSafeInteger(Number(retryMax))) {
    throw new Error('SRI_RETRY_MAX debe ser un entero');
  }
  return createSriConfig({
    enabledEnvironments,
    allowCustomEndpoints: custom.toLowerCase() === 'true',
    test: {
      reception: read(env, 'EINVOICE_SRI_TEST_RECEPTION') ?? OFFICIAL_ENDPOINTS.test.reception,
      authorization: read(env, 'EINVOICE_SRI_TEST_AUTHORIZATION') ?? OFFICIAL_ENDPOINTS.test.authorization,
    },
    production: {
      reception: read(env, 'EINVOICE_SRI_PRODUCTION_RECEPTION') ?? OFFICIAL_ENDPOINTS.production.reception,
      authorization:
        read(env, 'EINVOICE_SRI_PRODUCTION_AUTHORIZATION') ?? OFFICIAL_ENDPOINTS.production.authorization,
    },
    connectTimeoutMs: duration(env, 'SRI_CONNECT_TIMEOUT', '10s'),
    readTimeoutMs: duration(env, 'SRI_READ_TIMEOUT', '60s'),
    authorizationDelayMs: duration(env, 'SRI_AUTHORIZATION_DELAY', '3s'),
    retryBackoffMs: duration(env, 'SRI_RETRY_BACKOFF', '15s'),
    retryMaxBackoffMs: duration(env, 'EINVOICE_SRI_RETRY_MAX_BACKOFF', '1h'),
    retryMaxAttempts: Number(retryMax),
  });
}
