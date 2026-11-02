import {
  apiKeySecretMatches,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
} from '../../../src/apikey/api-key-credential.js';

const SHAPE = /^efk_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/;
const secretOf = (value: string) => value.substring('efk_'.length + 12 + 1);

describe('api-key-credential', () => {
  it('la clave generada tiene la forma documentada', () => {
    const g = generateApiKey();
    expect(g.value).toMatch(SHAPE);
    expect(g.publicId).toBe(g.value.substring(4, 16));
    expect(g.secretHash).toBe(hashApiKeySecret(secretOf(g.value)));
    expect(g.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dos claves generadas difieren', () => {
    const ids = new Set<string>();
    const values = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const g = generateApiKey();
      ids.add(g.publicId);
      values.add(g.value);
    }
    expect(ids.size).toBe(1000);
    expect(values.size).toBe(1000);
  });

  it('parse recupera publicId y secreto', () => {
    const g = generateApiKey();
    expect(parseApiKey(g.value)).toEqual({
      publicId: g.publicId,
      secret: secretOf(g.value),
    });
  });

  it('parse conserva secretos con guiones bajos', () => {
    expect(parseApiKey('efk_abcdefABCDEF_' + '_'.repeat(43))).toEqual({
      publicId: 'abcdefABCDEF',
      secret: '_'.repeat(43),
    });
  });

  it('parse recorta espacios alrededor, como trim() de Java', () => {
    const g = generateApiKey();
    expect(parseApiKey('  ' + g.value + '\n')).not.toBeNull();
    // trim() de Java solo quita hasta U+0020: un espacio de no ruptura no se recorta.
    expect(parseApiKey(' ' + g.value)).toBeNull();
  });

  it('parse rechaza lo mal formado', () => {
    const secret = 'a'.repeat(43);
    for (const bad of [
      null,
      '',
      '   ',
      'efk_',
      'efx_abcdefABCDEF_' + secret,
      'efk_abcdefABCDE_' + secret,
      'efk_abcdefABCDEF_' + 'a'.repeat(42),
      'efk_abcdefABCDEF_' + 'a'.repeat(42) + '+',
      'efk_abcdefABCDEF_' + 'a'.repeat(42) + '/',
      'efk_abcdefABCDEF_' + 'a'.repeat(20) + ' ' + 'a'.repeat(22),
    ]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  it('apiKeySecretMatches solo es cierto para el mismo secreto', () => {
    const s = 'a'.repeat(43);
    expect(apiKeySecretMatches(s, hashApiKeySecret(s))).toBe(true);
    expect(apiKeySecretMatches(s + 'x', hashApiKeySecret(s))).toBe(false);
    expect(apiKeySecretMatches(s, 'corto')).toBe(false);
  });
});
