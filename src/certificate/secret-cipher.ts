import { createCipheriv, createDecipheriv, randomBytes as cryptoRandomBytes } from 'node:crypto';

/** Token de inyección del cifrador de secretos. */
export const SECRET_CIPHER = Symbol('SECRET_CIPHER');

/** El secreto no se pudo cifrar o descifrar. El mensaje nunca incluye material secreto. */
export class SecretCipherException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretCipherException';
  }
}

const FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_KEY_BYTES = KEY_BYTES + TAG_BYTES;
const MINIMUM = 1 + IV_BYTES + WRAPPED_KEY_BYTES + IV_BYTES + TAG_BYTES;

function gcmEncrypt(key: Buffer, iv: Buffer, context: Buffer, input: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(context);
  return Buffer.concat([cipher.update(input), cipher.final(), cipher.getAuthTag()]);
}

function gcmDecrypt(key: Buffer, iv: Buffer, context: Buffer, input: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(context);
  decipher.setAuthTag(input.subarray(input.length - TAG_BYTES));
  return Buffer.concat([decipher.update(input.subarray(0, input.length - TAG_BYTES)), decipher.final()]);
}

/**
 * Cifrado de sobre con AES-256-GCM, compatible byte a byte con AesGcmSecretCipher de Java: cada
 * secreto se cifra con una clave de datos aleatoria, y esa clave se guarda envuelta con la clave
 * maestra. El contexto (AAD) se autentica junto con el secreto: un cifrado hecho para un registro
 * no se descifra presentándolo como de otro.
 *
 * Formato: versión (1 byte) | IV de envoltura (12) | clave de datos envuelta (32 + 16) | IV de
 * datos (12) | secreto cifrado con su etiqueta.
 */
export class AesGcmSecretCipher {
  private readonly masterKey: Buffer;

  constructor(
    masterKey: Buffer,
    /** Fuente de aleatorios; las pruebas golden la fijan para reproducir los bytes de Java. */
    private readonly randomBytes: (length: number) => Buffer = cryptoRandomBytes,
  ) {
    if (masterKey.length !== KEY_BYTES) {
      throw new Error(`La clave maestra debe tener ${KEY_BYTES} bytes`);
    }
    this.masterKey = Buffer.from(masterKey);
  }

  encrypt(plaintext: Buffer, context: Buffer): Buffer {
    try {
      // Mismo orden que Java: clave de datos, IV de envoltura, IV de datos.
      const dataKey = this.randomBytes(KEY_BYTES);
      const wrapIv = this.randomBytes(IV_BYTES);
      const wrappedKey = gcmEncrypt(this.masterKey, wrapIv, context, dataKey);
      const dataIv = this.randomBytes(IV_BYTES);
      const encrypted = gcmEncrypt(dataKey, dataIv, context, plaintext);
      dataKey.fill(0);
      return Buffer.concat([Buffer.of(FORMAT_VERSION), wrapIv, wrappedKey, dataIv, encrypted]);
    } catch {
      throw new SecretCipherException('No se pudo cifrar el secreto');
    }
  }

  decrypt(ciphertext: Buffer, context: Buffer): Buffer {
    if (ciphertext.length < MINIMUM || ciphertext[0] !== FORMAT_VERSION) {
      throw new SecretCipherException('El secreto cifrado no tiene el formato esperado');
    }
    let offset = 1;
    const take = (length: number) => ciphertext.subarray(offset, (offset += length));
    const wrapIv = take(IV_BYTES);
    const wrappedKey = take(WRAPPED_KEY_BYTES);
    const dataIv = take(IV_BYTES);
    const encrypted = ciphertext.subarray(offset);
    try {
      const dataKey = gcmDecrypt(this.masterKey, wrapIv, context, wrappedKey);
      try {
        return gcmDecrypt(dataKey, dataIv, context, encrypted);
      } finally {
        dataKey.fill(0);
      }
    } catch {
      throw new SecretCipherException('El secreto cifrado no se pudo descifrar');
    }
  }
}
