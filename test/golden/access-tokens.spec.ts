import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AccessTokens } from '../../src/identity/access-tokens.js';
import { testConfig } from '../support/test-env.js';

interface Case {
  userId: string;
  sessionId: string;
  email: string;
  emailVerified: boolean;
  issuedAtEpochSeconds: number;
  ttlSeconds: number;
  token: string;
}
const fixture = JSON.parse(readFileSync(new URL('./jwt.json', import.meta.url), 'utf8')) as {
  secret: string;
  issuer: string;
  audience: string;
  cases: Case[];
};

const auth = { ...testConfig.auth, jwtSecret: fixture.secret };
const decode = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('AccessTokens contra los tokens de Java', () => {
  it('hay casos', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it.each(fixture.cases.map((c, i) => [i, c] as const))(
    'caso %i: verify acepta el token',
    async (_i, c) => {
      const [h, p, s] = c.token.split('.') as [string, string, string];
      const mac = createHmac('sha256', fixture.secret).update(`${h}.${p}`).digest();
      expect(timingSafeEqual(mac, Buffer.from(s, 'base64url'))).toBe(true);

      const tokens = new AccessTokens(auth, () => new Date((c.issuedAtEpochSeconds + 1) * 1000));
      expect(await tokens.verify(c.token)).toEqual({
        sub: c.userId,
        sid: c.sessionId,
        email: c.email,
        emailVerified: c.emailVerified,
      });
    },
  );

  it.each(fixture.cases.map((c, i) => [i, c] as const))(
    'caso %i: issue produce la misma cabecera y los mismos claims',
    async (_i, c) => {
      const [h, p] = c.token.split('.') as [string, string];
      const javaClaims = decode(p);
      const now = new Date(c.issuedAtEpochSeconds * 1000);
      const tokens = new AccessTokens(
        { ...auth, accessTokenTtlMs: c.ttlSeconds * 1000 },
        () => now,
      );
      const issued = await tokens.issue(
        c.userId,
        c.sessionId,
        c.email,
        c.emailVerified,
        javaClaims.jti as string,
      );
      const [h2, p2] = issued.value.split('.') as [string, string];
      expect(decode(h2)).toEqual(decode(h));
      expect(decode(p2)).toEqual(javaClaims);
      expect(issued.expiresAt.getTime()).toBe((c.issuedAtEpochSeconds + c.ttlSeconds) * 1000);
    },
  );
});
