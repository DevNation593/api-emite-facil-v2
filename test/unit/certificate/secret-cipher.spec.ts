import { AesGcmSecretCipher, SecretCipherException } from '../../../src/certificate/secret-cipher.js';

// Traducción de AesGcmSecretCipherTest. La clave maestra llega ya decodificada de la configuración.
const KEY = Buffer.from('0123456789abcdef0123456789abcdef');
const OTHER_KEY = Buffer.from('fedcba9876543210fedcba9876543210');
const CONTEXT = Buffer.from('certificado-1');
const SECRET = Buffer.from('contenido secreto ñ');
const cipher = new AesGcmSecretCipher(KEY);

it('cifra y descifra', () => {
  const encrypted = cipher.encrypt(SECRET, CONTEXT);
  expect(cipher.decrypt(encrypted, CONTEXT)).toEqual(SECRET);
  expect(encrypted.toString('latin1')).not.toContain(SECRET.toString('latin1'));
  expect(cipher.decrypt(cipher.encrypt(Buffer.alloc(0), CONTEXT), CONTEXT)).toHaveLength(0);
});

it('la misma entrada se cifra distinto', () => {
  expect(cipher.encrypt(SECRET, CONTEXT).equals(cipher.encrypt(SECRET, CONTEXT))).toBe(false);
});

it('el formato es versión, IV, clave envuelta, IV y datos con su etiqueta', () => {
  const encrypted = cipher.encrypt(SECRET, CONTEXT);
  expect(encrypted[0]).toBe(1);
  expect(encrypted).toHaveLength(1 + 12 + 48 + 12 + SECRET.length + 16);
});

it('un contenido alterado no se descifra', () => {
  const encrypted = cipher.encrypt(SECRET, CONTEXT);
  for (const position of [0, 5, Math.floor(encrypted.length / 2), encrypted.length - 1]) {
    const tampered = Buffer.from(encrypted);
    tampered[position]! ^= 0x01;
    expect(() => cipher.decrypt(tampered, CONTEXT), `byte ${position}`).toThrow(SecretCipherException);
  }
  expect(() => cipher.decrypt(encrypted.subarray(0, encrypted.length - 4), CONTEXT)).toThrow(SecretCipherException);
  expect(() => cipher.decrypt(Buffer.alloc(3), CONTEXT)).toThrow(SecretCipherException);
});

it('otro contexto no descifra', () => {
  const encrypted = cipher.encrypt(SECRET, CONTEXT);
  expect(() => cipher.decrypt(encrypted, Buffer.from('certificado-2'))).toThrow(SecretCipherException);
});

it('otra clave maestra no descifra', () => {
  const encrypted = cipher.encrypt(SECRET, CONTEXT);
  expect(() => new AesGcmSecretCipher(OTHER_KEY).decrypt(encrypted, CONTEXT)).toThrow(SecretCipherException);
});

it('el error no lleva material secreto', () => {
  const encrypted = cipher.encrypt(SECRET, CONTEXT);
  try {
    cipher.decrypt(encrypted, Buffer.from('otro'));
    expect.unreachable();
  } catch (error) {
    expect((error as Error).message).toBe('El secreto cifrado no se pudo descifrar');
  }
});

it.each([16, 0, 31, 33])('rechaza una clave maestra de %i bytes', (length) => {
  expect(() => new AesGcmSecretCipher(Buffer.alloc(length, 7))).toThrow('debe tener 32 bytes');
});
