import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AesGcmSecretCipher } from '../../src/certificate/secret-cipher.js';

// Secretos cifrados por AesGcmSecretCipher de Java (tools/golden-generator, familia aes-gcm).
interface Case {
  context: string;
  plaintext: string;
  ciphertext: string;
}
const golden = JSON.parse(readFileSync(new URL('./aes-gcm.json', import.meta.url), 'utf8')) as {
  masterKey: string;
  cases: Case[];
};
const masterKey = Buffer.from(golden.masterKey, 'base64');

it('el golden trae casos de certificado y de webhook', () => {
  expect(golden.cases.some((c) => c.context.startsWith('certificate|'))).toBe(true);
  expect(golden.cases.some((c) => !c.context.startsWith('certificate|'))).toBe(true);
});

describe.each(golden.cases.map((c, i) => [i, c.context.split('|').pop(), c] as const))('#%i %s', (_i, _field, c) => {
  const context = Buffer.from(c.context, 'utf8');
  const ciphertext = Buffer.from(c.ciphertext, 'base64');
  const plaintext = Buffer.from(c.plaintext, 'base64');

  it('NestJS descifra lo que cifró Java', () => {
    expect(new AesGcmSecretCipher(masterKey).decrypt(ciphertext, context)).toEqual(plaintext);
  });

  it('con la misma clave de datos y los mismos IV, NestJS cifra los mismos bytes que Java', () => {
    // Formato: versión (1) | IV de envoltura (12) | clave envuelta (48) | IV de datos (12) | datos.
    const wrapIv = ciphertext.subarray(1, 13);
    const wrapped = ciphertext.subarray(13, 61);
    const dataIv = ciphertext.subarray(61, 73);
    const unwrap = createDecipheriv('aes-256-gcm', masterKey, wrapIv);
    unwrap.setAAD(context);
    unwrap.setAuthTag(wrapped.subarray(32));
    const dataKey = Buffer.concat([unwrap.update(wrapped.subarray(0, 32)), unwrap.final()]);
    // El orden en que Java pide los aleatorios: clave de datos, IV de envoltura, IV de datos.
    const draws = [dataKey, wrapIv, dataIv];
    const cipher = new AesGcmSecretCipher(masterKey, (length) => {
      const next = draws.shift()!;
      expect(next).toHaveLength(length);
      return Buffer.from(next);
    });
    expect(cipher.encrypt(plaintext, context).toString('base64')).toBe(c.ciphertext);
  });
});
