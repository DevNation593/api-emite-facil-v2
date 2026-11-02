import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { TOKEN_AUDIENCE, TOKEN_ISSUER, type AppConfig } from '../config/app-config.js';
import { strip } from '../common/java-text.js';

/** Lo que la API necesita de un token válido: el usuario, la sesión que lo obtuvo y su correo. */
export interface AccessClaims {
  sub: string;
  sid: string;
  email?: string;
  emailVerified?: boolean;
}

/** Spring (JwtTimestampValidator) tolera 60 s de desfase de reloj. */
const CLOCK_TOLERANCE_SECONDS = 60;

/**
 * Tokens de acceso de la API: JWT firmados con HS256 y la clave EINVOICE_JWT_SECRET. Los emite y
 * los valida esta misma aplicación, así que la firma simétrica basta. El sujeto es el id del
 * usuario y `sid`, el de la sesión que lo obtuvo.
 */
export class AccessTokens {
  private readonly key: Uint8Array;

  constructor(
    private readonly config: Pick<AppConfig['auth'], 'jwtSecret' | 'accessTokenTtlMs'>,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.key = new TextEncoder().encode(config.jwtSecret);
  }

  async issue(
    userId: string,
    sessionId: string,
    email: string,
    emailVerified: boolean,
    jti: string = randomUUID(),
  ): Promise<{ value: string; expiresAt: Date }> {
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.config.accessTokenTtlMs);
    const value = await new SignJWT({ sid: sessionId, email, email_verified: emailVerified })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setSubject(userId)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .setJti(jti)
      .sign(this.key);
    return { value, expiresAt };
  }

  /** Los claims de un token válido, o null por cualquier motivo: nunca lanza. */
  async verify(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: this.clock(),
        requiredClaims: ['exp', 'sub'],
      });
      const { sub, sid, email } = payload;
      if (typeof sub !== 'string' || strip(sub) === '' || typeof sid !== 'string') return null;
      const claims: AccessClaims = { sub, sid };
      if (typeof email === 'string') claims.email = email;
      if (typeof payload.email_verified === 'boolean')
        claims.emailVerified = payload.email_verified;
      return claims;
    } catch {
      return null;
    }
  }
}
