import { isIsoControl, isJavaWhitespace } from '../common/java-text.js';
import { parseDuration } from '../config/durations.js';

/*
 * Configuración de la entrega de comprobantes, como delivery/DeliveryProperties.java. El correo está desactivado
 * mientras no se habilite expresamente; habilitado, exige un remitente válido para arrancar.
 */

export interface DeliveryConfig {
  /** `from` es solo la dirección, sin nombre: el nombre visible es el del emisor de cada comprobante. */
  email: { enabled: boolean; from: string | null };
  retryBackoffMs: number;
  retryMaxBackoffMs: number;
  retryMaxAttempts: number;
  /** Plazo tras el cual un envío que no dejó resultado se da por abandonado y se repite. */
  sendLeaseMs: number;
  /** Tope de entregas por comprobante, contando los reenvíos manuales. */
  maxPerDocument: number;
}

function requirePositive(name: string, value: number): void {
  if (!(value > 0)) throw new Error(`einvoice.delivery.${name} debe ser mayor que cero`);
}

/** Comprueba la configuración como el constructor de DeliveryProperties. */
export function createDeliveryConfig(config: DeliveryConfig): DeliveryConfig {
  if (config.email.enabled && !validAddress(config.email.from)) {
    throw new Error('einvoice.delivery.email.from debe ser una dirección de correo válida para habilitar el envío');
  }
  requirePositive('retry-backoff', config.retryBackoffMs);
  requirePositive('retry-max-backoff', config.retryMaxBackoffMs);
  requirePositive('send-lease', config.sendLeaseMs);
  if (!(config.retryMaxAttempts >= 1)) throw new Error('einvoice.delivery.retry-max-attempts debe ser al menos 1');
  if (!(config.maxPerDocument >= 1)) throw new Error('einvoice.delivery.max-per-document debe ser al menos 1');
  return config;
}

const MAX_ADDRESS = 254;

/** Los que el formato de correo usa para expresar varias direcciones en un valor, que el servidor expandiría. */
const SEPARATORS = ',;:<>()"';

/** Lo que `validAddress` de Java excluye antes de leer la dirección: controles, espacios y esos separadores. */
function excluded(character: string): boolean {
  return isIsoControl(character) || isJavaWhitespace(character) || SEPARATORS.includes(character);
}

/** Los `specialsNoDot` de InternetAddress que no se excluyen antes y no tienen regla propia. */
const LOCAL_SPECIALS = /[[\]]/;

const LETTER_OR_DIGIT = /^[\p{L}\p{Nd}]$/u;

/** `InternetAddress.checkAddress(addr, true, true)` de Jakarta Mail sobre un texto sin los caracteres excluidos. */
function isSingleAddress(address: string): boolean {
  if (address.startsWith('@')) return false;
  let c = '';
  let last = '';
  let i = 0;
  // La parte local: sin especiales, sin puntos en los extremos ni seguidos; tras una barra invertida vale todo.
  for (; i < address.length; i++) {
    last = c;
    c = address.charAt(i);
    if (c === '\\' || last === '\\') continue;
    if (c === '.' && (i === 0 || last === '.')) return false;
    if (c === '@') {
      if (last === '.') return false;
      break;
    }
    if (LOCAL_SPECIALS.test(c)) return false;
  }
  // Sin una arroba que cierre la parte local, o sin nada detrás, no hay dominio.
  const start = i + 1;
  if (i >= address.length || start >= address.length || address.charAt(start) === '.') return false;
  let inLiteral = false;
  last = '';
  for (let j = start; j < address.length; j++) {
    c = address.charAt(j);
    if (c === '[') {
      if (j !== start) return false;
      inLiteral = true;
    } else if (c === ']') {
      if (j !== address.length - 1) return false;
      inLiteral = false;
    } else if (!inLiteral) {
      if (c !== '-' && c !== '.' && !LETTER_OR_DIGIT.test(c)) return false;
      if (c === '.' && last === '.') return false;
    }
    last = c;
  }
  return last !== '.' && !inLiteral;
}

/** Una sola dirección, sin nombre, comentarios ni caracteres de control. */
export function validAddress(address: string | null): boolean {
  if (address === null || address === '' || address.length > MAX_ADDRESS) return false;
  if (Array.from(address).some(excluded)) return false;
  return isSingleAddress(address);
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

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = read(env, name) ?? String(fallback);
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${name} debe ser un entero`);
  return Number(raw);
}

/** Los textos que el conversor de Spring lee como booleano. */
function boolean(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = (read(env, name) ?? 'false').toLowerCase();
  if (['true', 'on', 'yes', '1'].includes(raw)) return true;
  if (['false', 'off', 'no', '0'].includes(raw)) return false;
  throw new Error(`${name} debe ser true o false`);
}

/**
 * Lee la configuración del entorno con los nombres de application.yml (`DELIVERY_EMAIL_*`) y los relajados de
 * Spring para lo que allí no tiene variable propia (`EINVOICE_DELIVERY_*`).
 */
export function loadDeliveryConfig(env: NodeJS.ProcessEnv): DeliveryConfig {
  return createDeliveryConfig({
    email: { enabled: boolean(env, 'DELIVERY_EMAIL_ENABLED'), from: env.DELIVERY_EMAIL_FROM ?? null },
    retryBackoffMs: duration(env, 'EINVOICE_DELIVERY_RETRY_BACKOFF', '1m'),
    retryMaxBackoffMs: duration(env, 'EINVOICE_DELIVERY_RETRY_MAX_BACKOFF', '6h'),
    retryMaxAttempts: integer(env, 'EINVOICE_DELIVERY_RETRY_MAX_ATTEMPTS', 12),
    sendLeaseMs: duration(env, 'EINVOICE_DELIVERY_SEND_LEASE', '10m'),
    maxPerDocument: integer(env, 'EINVOICE_DELIVERY_MAX_PER_DOCUMENT', 10),
  });
}
