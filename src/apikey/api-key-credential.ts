import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Formato de las API keys: `efk_<publicId>_<secreto>`. El publicId (12 caracteres alfanuméricos)
 * identifica la clave y se puede guardar y mostrar; el secreto (43 caracteres base64 URL, 256 bits)
 * solo se entrega una vez y se guarda como SHA-256.
 *
 * Basta SHA-256, sin sal ni función lenta: el secreto sale de un generador criptográfico y tiene
 * 256 bits de entropía, así que no hay diccionario ni fuerza bruta que acelerar.
 */
const PREFIX = 'efk_';
const PUBLIC_ID_LENGTH = 12;
const SECRET_BYTES = 32;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SHAPE = /^efk_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/;

/** Clave recién creada: el valor completo se muestra una vez; en la base solo van publicId y hash. */
export interface GeneratedApiKey {
  value: string;
  publicId: string;
  secretHash: string;
}

/** Lo que llega en el encabezado, ya separado. */
export interface PresentedApiKey {
  publicId: string;
  secret: string;
}

export function generateApiKey(): GeneratedApiKey {
  let publicId = '';
  for (let i = 0; i < PUBLIC_ID_LENGTH; i++) {
    publicId += ALPHABET.charAt(randomInt(ALPHABET.length));
  }
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return {
    value: `${PREFIX}${publicId}_${secret}`,
    publicId,
    secretHash: hashApiKeySecret(secret),
  };
}

/** `String.trim()` de Java quita todo carácter hasta U+0020, no los espacios Unicode que quita el de JS. */
function javaTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.substring(start, end);
}

/**
 * Separa el valor del encabezado. El secreto puede contener guiones bajos, por eso se corta por
 * posición y no por el último guion bajo.
 */
export function parseApiKey(header: string | null): PresentedApiKey | null {
  if (header === null || header === undefined) return null;
  const value = javaTrim(header);
  if (!SHAPE.test(value)) return null;
  const idEnd = PREFIX.length + PUBLIC_ID_LENGTH;
  return { publicId: value.substring(PREFIX.length, idEnd), secret: value.substring(idEnd + 1) };
}

/** SHA-256 en 64 caracteres hexadecimales en minúscula. */
export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Compara en tiempo constante el hash del secreto presentado con el guardado. */
export function apiKeySecretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashApiKeySecret(secret), 'ascii');
  const b = Buffer.from(storedHash, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}
