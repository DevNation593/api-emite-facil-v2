import { readFileSync } from 'node:fs';

// Comprobaciones de forma de los fixtures generados con la API Java
// (tools/golden-generator). Los valores concretos los consumen las etapas E1–E4.
const url = (f: string) => new URL(f, import.meta.url);
const read = (f: string) =>
  JSON.parse(readFileSync(url(f), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('golden files', () => {
  it('SOURCE.json: commit, versión de Java y fecha', () => {
    const s = read('./SOURCE.json');
    expect(s.javaRepoCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof s.javaVersion).toBe('string');
    expect(Number.isNaN(Date.parse(s.generatedAt))).toBe(false);
  });

  it('access-key: 50+ casos y claves de 49 dígitos', () => {
    const { cases, validity } = read('./access-key.json');
    expect(cases.length).toBeGreaterThanOrEqual(50);
    for (const c of cases) {
      expect(c.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.base48).toMatch(/^\d{48}$/);
      expect(c.accessKey).toMatch(/^\d{49}$/);
      expect(c.accessKey).toBe(c.base48 + c.accessKey.at(-1));
      expect(typeof c.sequence).toBe('number');
      for (const f of [
        'documentType',
        'ruc',
        'environment',
        'establishment',
        'emissionPoint',
        'numericCode',
        'emissionType',
      ]) {
        expect(typeof c[f]).toBe('string');
      }
    }
    // Módulo 11: resultado 10 -> 1 y 11 -> 0; el generador los busca a propósito.
    const mapped = (check: string) =>
      cases.filter((c: { accessKey: string }) => c.accessKey.at(-1) === check)
        .length;
    expect(mapped('1')).toBeGreaterThanOrEqual(3);
    expect(mapped('0')).toBeGreaterThanOrEqual(3);
    expect(validity.some((v: { valid: boolean }) => v.valid)).toBe(true);
    expect(validity.some((v: { valid: boolean }) => !v.valid)).toBe(true);
    expect(validity.some((v: { key: string }) => v.key.length === 48)).toBe(
      true,
    );
    expect(validity.some((v: { key: string }) => v.key.length === 50)).toBe(
      true,
    );
    expect(validity.some((v: { key: string }) => /[A-Za-z]/.test(v.key))).toBe(
      true,
    );
  });

  it('aes-gcm: clave maestra y casos con los tres contextos', () => {
    const { masterKey, cases } = read('./aes-gcm.json');
    expect(Buffer.from(masterKey, 'base64')).toHaveLength(32);
    const contexts: string[] = cases.map((c: { context: string }) => c.context);
    expect(
      contexts.some(
        (c) => {
          const segments = c.split('|');
          return (
            segments.length === 5 &&
            segments[0] === 'certificate' &&
            segments[4] === 'p12' &&
            segments.slice(1, 4).every((p) => uuid.test(p))
          );
        },
      ),
    ).toBe(true);
    expect(
      contexts.some(
        (c) => c.startsWith('certificate|') && c.endsWith('|password'),
      ),
    ).toBe(true);
    expect(
      contexts.some(
        (c) =>
          c.startsWith('webhook|') &&
          c.split('|').length === 3 &&
          c
            .split('|')
            .slice(1)
            .every((p) => uuid.test(p)),
      ),
    ).toBe(true);
    const sizes = cases.map(
      (c: { plaintext: string }) => Buffer.from(c.plaintext, 'base64').length,
    );
    expect(sizes).toContain(1);
    expect(sizes).toContain(32);
    expect(Math.max(...sizes)).toBeGreaterThan(1000);
    for (const c of cases) {
      expect(c.plaintext).toMatch(base64);
      expect(c.ciphertext).toMatch(base64);
      expect(Buffer.from(c.ciphertext, 'base64')[0]).toBe(1); // versión de formato
    }
  });

  it('argon2: hashes argon2id con contraseñas de 12, 128, tildes, ñ y emoji', () => {
    const { cases } = read('./argon2.json');
    const lengths = cases.map(
      (c: { password: string }) => Array.from(c.password).length,
    );
    expect(lengths).toContain(12);
    expect(lengths).toContain(128);
    const all = cases.map((c: { password: string }) => c.password).join('');
    expect(all).toMatch(/[áéíóú]/);
    expect(all).toContain('ñ');
    expect(all).toMatch(/\p{Extended_Pictographic}/u);
    for (const c of cases)
      expect(c.hash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/);
  });

  it('jwt: tokens HS256 con ttl 900', () => {
    const { secret, issuer, audience, cases } = read('./jwt.json');
    expect(Buffer.byteLength(secret)).toBeGreaterThanOrEqual(32);
    expect(issuer).toBe('einvoice-api');
    expect(audience).toBe('einvoice-api');
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.ttlSeconds).toBe(900);
      expect(c.userId).toMatch(uuid);
      expect(c.sessionId).toMatch(uuid);
      expect(typeof c.emailVerified).toBe('boolean');
      const [h, p] = c.token.split('.');
      expect(JSON.parse(Buffer.from(h, 'base64url').toString()).alg).toBe(
        'HS256',
      );
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      expect(claims.sub).toBe(c.userId);
      expect(claims.sid).toBe(c.sessionId);
      expect(claims.iat).toBe(c.issuedAtEpochSeconds);
      expect(claims.exp).toBe(c.issuedAtEpochSeconds + 900);
    }
  });

  it('api-key: formato efk_<publicId>_<secreto> y SHA-256 hexadecimal', () => {
    const { cases } = read('./api-key.json');
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.value).toMatch(/^efk_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
      expect(c.value.slice(4, 16)).toBe(c.publicId);
      expect(c.secretHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('bean-validation: casos de las ocho restricciones con mensajes de Hibernate', () => {
    const { cases } = read('./bean-validation.json');
    const kinds = new Set(cases.map((c: { constraint: string }) => c.constraint));
    expect(kinds).toEqual(
      new Set(['NotBlank', 'NotNull', 'Size', 'Email', 'NoControlChars', 'Pattern', 'Min', 'Max']),
    );
    for (const c of cases) {
      expect(typeof c.valid).toBe('boolean');
      expect(c.value === null || typeof c.value === 'string' || typeof c.value === 'number').toBe(true);
      expect(c.message === null).toBe(c.valid);
    }
    expect(
      cases.some((c: { constraint: string; message: string }) => c.constraint === 'NoControlChars' && c.message === 'must match "[^\\p{Cntrl}]*"'),
    ).toBe(true);
  });

  it('xades: cada caso tiene XML sin firmar, firmado y metadatos', () => {
    expect(
      readFileSync(url('./xades/certificado-prueba.p12')).length,
    ).toBeGreaterThan(500);
    for (const name of ['factura-estandar', 'factura-con-ruc-proveedor']) {
      const unsigned = readFileSync(
        url(`./xades/${name}/unsigned.xml`),
        'utf8',
      );
      const signed = readFileSync(url(`./xades/${name}/signed.xml`), 'utf8');
      expect(unsigned).toContain('<factura');
      expect(unsigned).not.toContain('<ds:Signature');
      expect(signed).toContain('<ds:Signature');
      // El prefijo es etsi (estructura del Anexo 14 del SRI), no xades.
      expect(signed).toContain('<etsi:SignedProperties');
      const meta = read(`./xades/${name}/meta.json`);
      expect(meta.signingTime).toMatch(/-05:00$/);
      expect(meta.p12).toBe('certificado-prueba.p12');
      expect(meta.p12Password).toBe('clave-de-prueba-p12');
    }
    expect(
      readFileSync(
        url('./xades/factura-con-ruc-proveedor/unsigned.xml'),
        'utf8',
      ),
    ).toContain('1790012345001');
  });
});
