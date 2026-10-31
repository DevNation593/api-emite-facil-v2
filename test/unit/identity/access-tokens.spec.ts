import { SignJWT } from 'jose';
import { AccessTokens } from '../../../src/identity/access-tokens.js';
import { testConfig } from '../../support/test-env.js';

const auth = testConfig.auth;
const key = new TextEncoder().encode(auth.jwtSecret);
const NOW = new Date('2026-10-30T12:00:00Z');
const seconds = (d: Date) => Math.floor(d.getTime() / 1000);
const tokens = new AccessTokens(auth, () => NOW);
const USER = '91a20fe4-457a-4197-811e-176df5d4a757';
const SESSION = 'd9074531-24a0-412e-99a7-738b55ad8204';

interface Override {
  iss?: string | null;
  aud?: string | string[] | null;
  sub?: string | null;
  exp?: number | null;
  alg?: 'HS256' | 'HS512';
  key?: Uint8Array;
}

/** Un token propio con los claims válidos y los cambios que pida cada caso. */
async function craft(over: Override = {}): Promise<string> {
  const jwt = new SignJWT({ sid: SESSION }).setProtectedHeader({
    alg: over.alg ?? 'HS256',
  });
  jwt.setIssuedAt(seconds(NOW) - 100);
  if (over.iss !== null) jwt.setIssuer(over.iss ?? 'einvoice-api');
  if (over.aud !== null) jwt.setAudience(over.aud ?? 'einvoice-api');
  if (over.sub !== null) jwt.setSubject(over.sub ?? USER);
  if (over.exp !== null) jwt.setExpirationTime(over.exp ?? seconds(NOW) + 600);
  return jwt.sign(over.key ?? key);
}
const expiradoHace = (s: number) => craft({ exp: seconds(NOW) - s });
const payloadOf = (t: string) =>
  JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as {
    jti: string;
    aud: unknown;
  };

describe('AccessTokens', () => {
  it('lee de vuelta lo que emite', async () => {
    const issued = await tokens.issue(USER, SESSION, 'a@b.ec', true);
    expect(issued.expiresAt.getTime()).toBe(NOW.getTime() + auth.accessTokenTtlMs);
    expect(await tokens.verify(issued.value)).toEqual({
      sub: USER,
      sid: SESSION,
      email: 'a@b.ec',
      emailVerified: true,
    });
  });

  it('emite un jti distinto cada vez, salvo que se dé uno', async () => {
    const a = payloadOf((await tokens.issue(USER, SESSION, 'a@b.ec', false)).value);
    const b = payloadOf((await tokens.issue(USER, SESSION, 'a@b.ec', false)).value);
    expect(a.jti).not.toBe(b.jti);
    expect(a.aud).toBe('einvoice-api'); // Nimbus escribe una audiencia sola como texto
    const fixed = payloadOf((await tokens.issue(USER, SESSION, 'a@b.ec', false, 'jti-fijo')).value);
    expect(fixed.jti).toBe('jti-fijo');
  });

  it('el reloj inyectado vale al emitir y al verificar', async () => {
    const past = new AccessTokens(auth, () => new Date(NOW.getTime() - 3_600_000));
    const expired = (await past.issue(USER, SESSION, 'a@b.ec', false)).value;
    expect(await tokens.verify(expired)).toBeNull();
  });

  it('tolera 60 s de desfase y no más', async () => {
    expect(await tokens.verify(await expiradoHace(30))).not.toBeNull();
    expect(await tokens.verify(await expiradoHace(61))).toBeNull();
  });

  it('rechaza otro emisor, otra audiencia, sin exp, sin sujeto o con sujeto vacío', async () => {
    expect(await tokens.verify(await craft({ iss: 'otro' }))).toBeNull();
    expect(await tokens.verify(await craft({ iss: null }))).toBeNull();
    expect(await tokens.verify(await craft({ aud: 'otra-api' }))).toBeNull();
    expect(await tokens.verify(await craft({ aud: null }))).toBeNull();
    expect(await tokens.verify(await craft({ exp: null }))).toBeNull();
    expect(await tokens.verify(await craft({ sub: null }))).toBeNull();
    expect(await tokens.verify(await craft({ sub: '' }))).toBeNull();
    expect(await tokens.verify(await craft({ sub: '   ' }))).toBeNull();
  });

  it('acepta la audiencia como texto o como lista', async () => {
    expect(await tokens.verify(await craft({ aud: 'einvoice-api' }))).not.toBeNull();
    expect(await tokens.verify(await craft({ aud: ['otra', 'einvoice-api'] }))).not.toBeNull();
  });

  it('rechaza HS512, otra clave, alg none y basura, sin lanzar', async () => {
    expect(await tokens.verify(await craft({ alg: 'HS512' }))).toBeNull();
    const other = new TextEncoder().encode('otra-clave-distinta-0123456789-abcdef');
    expect(await tokens.verify(await craft({ key: other }))).toBeNull();
    const claims = {
      sub: USER,
      iss: 'einvoice-api',
      aud: 'einvoice-api',
      exp: seconds(NOW) + 600,
    };
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      JSON.stringify(claims),
    ).toString('base64url')}.`;
    expect(await tokens.verify(none)).toBeNull();
    for (const junk of ['', 'abc', 'a.b.c', '....']) {
      expect(await tokens.verify(junk)).toBeNull();
    }
  });

  it('un token sin sid no sirve para una sesión: se rechaza', async () => {
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('einvoice-api')
      .setAudience('einvoice-api')
      .setSubject(USER)
      .setExpirationTime(seconds(NOW) + 600)
      .sign(key);
    expect(await tokens.verify(t)).toBeNull();
  });
});
