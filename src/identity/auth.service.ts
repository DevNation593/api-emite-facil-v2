import { createHash, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { type Kysely, type Transaction, sql } from 'kysely';
import { Counter, type Registry } from 'prom-client';
import { ApiException } from '../common/api-exception.js';
import { codePointLength, strip } from '../common/java-text.js';
import { type AppConfig, authLink } from '../config/app-config.js';
import type { DB } from '../database/schema.js';
import type { AccessTokens } from './access-tokens.js';
import type { AuthAttemptLimiter } from './auth-attempt-limiter.js';
import {
  type AuthMail,
  type AuthMailer,
  alreadyRegisteredMail,
  passwordResetMail,
  verificationMail,
} from './auth-mailer.js';
import type { Passwords } from './passwords.js';

/** Correos de un mismo tipo que se envían como mucho por usuario y hora. */
export const MAX_EMAILS_PER_HOUR = 5;

const VERIFY_EMAIL = 'VERIFY_EMAIL';
const RESET_PASSWORD = 'RESET_PASSWORD';
const ALREADY_REGISTERED = 'ALREADY_REGISTERED';
type LinkKind =
  | typeof VERIFY_EMAIL
  | typeof RESET_PASSWORD
  | typeof ALREADY_REGISTERED;

export interface Tokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

interface Account {
  id: string;
  email: string | null;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
}

interface Opened {
  refreshToken: string;
  sessionEnds: Date;
}

/** Lo que la transacción de `refresh` decide; el error, si lo hay, se lanza ya confirmada. */
type RefreshOutcome =
  | { kind: 'rotated'; account: Account; sessionId: string; opened: Opened }
  | { kind: 'rejected' };

type Tx = Transaction<DB>;

export function normalize(email: string | null | undefined): string {
  return email == null ? '' : strip(email).toLowerCase();
}

export function sha256(value: string | null | undefined): string {
  return createHash('sha256')
    .update(value ?? '', 'utf8')
    .digest('hex');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Cuentas y sesiones. Un ingreso abre una sesión que dura como mucho session-ttl; cada renovación
 * entrega un token de acceso nuevo y cambia el de renovación. Los enlaces de los correos y los
 * tokens de renovación solo se guardan como SHA-256. Las respuestas no revelan si un correo tiene
 * cuenta. Ninguna transacción envía correo ni espera a Argon2 (salvo `changePassword`, que debe
 * comprobar la contraseña actual bajo el bloqueo de la fila): los correos salen tras confirmar.
 */
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly logins: Counter<'result'>;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly passwords: Passwords,
    private readonly accessTokens: AccessTokens,
    private readonly limiter: AuthAttemptLimiter,
    private readonly mailer: AuthMailer,
    private readonly auth: AppConfig['auth'],
    registry: Registry,
  ) {
    this.logins = new Counter({
      name: 'einvoice_auth_logins_total',
      help: 'Intentos de ingreso con correo y contraseña, por resultado',
      labelNames: ['result'],
      registers: [registry],
    });
    // Como en Java, los tres resultados existen desde el arranque, aunque valgan cero.
    for (const result of ['success', 'failure', 'locked']) {
      this.logins.inc({ result }, 0);
    }
  }

  /**
   * Crea la cuenta y envía el enlace para confirmar el correo. Si el correo ya tiene cuenta no
   * cambia nada: le llega un aviso con un enlace para cambiar la contraseña, y quien llama ve la
   * misma respuesta.
   */
  async register(rawEmail: string, password: string): Promise<void> {
    const email = normalize(rawEmail);
    this.passwords.requireAcceptable('password', password, email);
    // Con o sin cuenta previa se paga el mismo Argon2, y fuera de la transacción.
    const hash = await this.passwords.hash(password);
    const mails: AuthMail[] = [];
    await this.db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('users')
        .values({ email, password_hash: hash })
        .onConflict((oc) => oc.column('email').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (created !== undefined) {
        await this.sendLink(trx, created.id, email, VERIFY_EMAIL, mails);
        this.logger.log(`auth.registered user=${created.id}`);
        return;
      }
      const existing = await this.account(trx, email);
      if (existing !== undefined) {
        await this.sendLink(trx, existing.id, email, ALREADY_REGISTERED, mails);
      }
    });
    this.dispatch(mails);
  }

  async login(
    rawEmail: string,
    password: string,
    clientIp: string | null,
  ): Promise<Tokens> {
    await this.requireIpAllowed(clientIp);
    const email = normalize(rawEmail);
    const locked = await this.limiter.lockedFor(email);
    if (locked > 0) {
      this.logins.inc({ result: 'locked' });
      throw lockedError(locked);
    }
    const account = await this.account(this.db, email);
    // Argon2, siempre contra un hash y fuera de la transacción.
    if (!(await this.passwords.matches(password, account?.passwordHash ?? null))) {
      const lockedNow = await this.limiter.recordFailure(email);
      this.logins.inc({ result: 'failure' });
      this.logger.warn(`auth.login.failed user=${account?.id ?? 'desconocido'}`);
      if (lockedNow > 0) {
        this.logins.inc({ result: 'locked' });
        throw lockedError(lockedNow);
      }
      throw new ApiException(
        401,
        'INVALID_CREDENTIALS',
        'Correo o contraseña incorrectos',
      );
    }
    await this.limiter.recordSuccess(email);
    const user = account!;
    const { sessionId, opened } = await this.db
      .transaction()
      .execute(async (trx) => {
        // Argon2 corrió fuera de la transacción: un cambio o una recuperación de la contraseña pudo
        // confirmarse entre medias y cerrar ya las sesiones. Con la fila bloqueada se comprueba que
        // el hash validado siga vigente; si no, esta sesión nacería tras el cierre y sobreviviría.
        // Java tiene esta carrera; aquí se cierra sin cambiar ninguna respuesta sin concurrencia.
        const current = await trx
          .selectFrom('users')
          .select('password_hash')
          .where('id', '=', user.id)
          .forUpdate()
          .executeTakeFirst();
        if (current?.password_hash !== user.passwordHash) {
          throw new ApiException(
            401,
            'INVALID_CREDENTIALS',
            'Correo o contraseña incorrectos',
          );
        }
        const session = await trx
          .insertInto('auth_sessions')
          .values({
            user_id: user.id,
            expires_at: sql<Date>`now() + make_interval(secs => CAST(${seconds(this.auth.sessionTtlMs)} AS double precision))`,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return { sessionId: session.id, opened: await this.open(trx, session.id) };
      });
    const tokens = await this.tokens(user, sessionId, opened);
    this.logins.inc({ result: 'success' });
    this.logger.log(`auth.login user=${user.id}`);
    return tokens;
  }

  /**
   * Renueva el token de acceso y cambia el de renovación. Un token de renovación que ya se usó
   * delata que alguien más lo tiene: se cierra la sesión entera, y ese cierre se confirma antes de
   * rechazar la petición (lanzar dentro de la transacción lo desharía).
   */
  async refresh(refreshToken: string): Promise<Tokens> {
    const hash = sha256(refreshToken);
    const outcome = await this.db
      .transaction()
      .execute(async (trx): Promise<RefreshOutcome> => {
        const row = await trx
          .selectFrom('auth_refresh_tokens as t')
          .innerJoin('auth_sessions as s', 's.id', 't.session_id')
          .innerJoin('users as u', 'u.id', 's.user_id')
          .select([
            't.session_id',
            't.used_at',
            's.expires_at',
            's.revoked_at',
            'u.id as user_id',
            'u.email',
            'u.password_hash',
            'u.email_verified_at',
          ])
          .where('t.token_hash', '=', hash)
          // Dos renovaciones a la vez se serializan aquí: la segunda ve `used_at` y es una reutilización.
          .forUpdate(['t', 's'])
          .executeTakeFirst();
        if (
          row === undefined ||
          row.revoked_at !== null ||
          row.expires_at.getTime() <= Date.now()
        ) {
          return { kind: 'rejected' };
        }
        if (row.used_at !== null) {
          await this.revoke(trx, row.session_id, 'TOKEN_REUSED');
          this.logger.warn(
            `auth.refresh.reused user=${row.user_id} session=${row.session_id}`,
          );
          return { kind: 'rejected' };
        }
        await trx
          .updateTable('auth_refresh_tokens')
          .set({ used_at: sql<Date>`now()` })
          .where('token_hash', '=', hash)
          .execute();
        await trx
          .updateTable('auth_sessions')
          .set({ last_used_at: sql<Date>`now()` })
          .where('id', '=', row.session_id)
          .execute();
        return {
          kind: 'rotated',
          sessionId: row.session_id,
          account: {
            id: row.user_id,
            email: row.email,
            passwordHash: row.password_hash,
            emailVerifiedAt: row.email_verified_at,
          },
          opened: await this.open(trx, row.session_id),
        };
      });
    if (outcome.kind === 'rotated') {
      return this.tokens(outcome.account, outcome.sessionId, outcome.opened);
    }
    throw new ApiException(
      401,
      'INVALID_REFRESH_TOKEN',
      'La sesión caducó o se cerró; vuelva a ingresar',
    );
  }

  /** Cierra la sesión de ese token de renovación. Sin efecto si no existe o ya estaba cerrada. */
  async logout(refreshToken: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const found = await trx
        .selectFrom('auth_refresh_tokens')
        .select('session_id')
        .where('token_hash', '=', sha256(refreshToken))
        .executeTakeFirst();
      if (found !== undefined) await this.revoke(trx, found.session_id, 'LOGOUT');
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.db.transaction().execute(async (trx) => {
      const id = await this.consume(trx, token, VERIFY_EMAIL);
      await trx
        .updateTable('users')
        .set({ email_verified_at: sql<Date>`now()` })
        .where('id', '=', id)
        .where('email_verified_at', 'is', null)
        .execute();
      return id;
    });
    this.logger.log(`auth.email.verified user=${userId}`);
  }

  async resendVerification(userId: string): Promise<void> {
    const mails: AuthMail[] = [];
    await this.db.transaction().execute(async (trx) => {
      const account = await this.accountById(trx, userId);
      if (account === undefined) throw new Error('Usuario inexistente');
      if (account.emailVerifiedAt === null && account.email !== null) {
        await this.sendLink(trx, account.id, account.email, VERIFY_EMAIL, mails);
      }
    });
    this.dispatch(mails);
  }

  /** Envía el enlace para cambiar la contraseña si el correo tiene cuenta; la respuesta es la misma si no. */
  async requestPasswordReset(
    rawEmail: string,
    clientIp: string | null,
  ): Promise<void> {
    await this.requireIpAllowed(clientIp);
    const email = normalize(rawEmail);
    const mails: AuthMail[] = [];
    await this.db.transaction().execute(async (trx) => {
      const account = await this.account(trx, email);
      if (account !== undefined) {
        await this.sendLink(trx, account.id, email, RESET_PASSWORD, mails);
      }
    });
    this.dispatch(mails);
  }

  /**
   * Pone la contraseña nueva y cierra todas las sesiones. Haber recibido el enlace prueba que el
   * correo es suyo, así que también queda confirmado. Una contraseña rechazada deshace el consumo
   * del enlace: se puede volver a intentar con el mismo.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    // Argon2 fuera de la transacción. Si la longitud ya no sirve, se deja que la regla rechace
    // dentro, después de consumir el enlace, como Java.
    const hash = isPlausibleLength(newPassword)
      ? await this.passwords.hash(newPassword)
      : null;
    const { userId, email } = await this.db
      .transaction()
      .execute(async (trx) => {
        const id = await this.consume(trx, token, RESET_PASSWORD);
        const user = await trx
          .selectFrom('users')
          .select('email')
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        this.passwords.requireAcceptable('newPassword', newPassword, user.email);
        await trx
          .updateTable('users')
          .set({
            // `hash` es null solo si la longitud no era válida, y entonces la regla ya lanzó.
            password_hash: hash!,
            email_verified_at: sql<Date>`COALESCE(email_verified_at, now())`,
          })
          .where('id', '=', id)
          .execute();
        // Los demás enlaces pendientes para cambiarla dejan de servir.
        await trx
          .updateTable('user_tokens')
          .set({ used_at: sql<Date>`now()` })
          .where('user_id', '=', id)
          .where('purpose', '=', RESET_PASSWORD)
          .where('used_at', 'is', null)
          .execute();
        await this.revokeAll(trx, id, null, 'PASSWORD_RESET');
        return { userId: id, email: user.email };
      });
    await this.limiter.recordSuccess(email ?? '');
    this.logger.log(`auth.password.reset user=${userId}`);
  }

  /** Cambia la contraseña conociendo la actual y cierra las demás sesiones; la que hace el cambio sigue. */
  async changePassword(
    userId: string,
    currentSession: string | null,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('users')
        .select(['id', 'email', 'password_hash', 'email_verified_at'])
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!(await this.passwords.matches(currentPassword, row.password_hash))) {
        throw new ApiException(
          422,
          'INVALID_CURRENT_PASSWORD',
          'La contraseña actual no es correcta',
          [{ field: 'currentPassword', message: 'No es la contraseña actual' }],
        );
      }
      this.passwords.requireAcceptable('newPassword', newPassword, row.email);
      await trx
        .updateTable('users')
        .set({ password_hash: await this.passwords.hash(newPassword) })
        .where('id', '=', userId)
        .execute();
      await this.revokeAll(trx, userId, currentSession, 'PASSWORD_CHANGED');
    });
    this.logger.log(`auth.password.changed user=${userId}`);
  }

  /** Guarda el token de renovación nuevo y lee cuándo termina la sesión. */
  private async open(trx: Tx, sessionId: string): Promise<Opened> {
    const refreshToken = randomToken();
    await trx
      .insertInto('auth_refresh_tokens')
      .values({ token_hash: sha256(refreshToken), session_id: sessionId })
      .execute();
    const session = await trx
      .selectFrom('auth_sessions')
      .select('expires_at')
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    return { refreshToken, sessionEnds: session.expires_at };
  }

  /** Firma el token de acceso, ya sin transacción abierta. */
  private async tokens(
    user: Account,
    sessionId: string,
    opened: Opened,
  ): Promise<Tokens> {
    const access = await this.accessTokens.issue(
      user.id,
      sessionId,
      user.email ?? '',
      user.emailVerifiedAt !== null,
    );
    const expiresIn = Math.max(
      1,
      Math.floor((access.expiresAt.getTime() - Date.now()) / 1000),
    );
    return {
      accessToken: access.value,
      expiresIn,
      refreshToken: opened.refreshToken,
      refreshExpiresAt: opened.sessionEnds,
    };
  }

  private async revoke(
    trx: Tx,
    sessionId: string,
    reason: string,
  ): Promise<void> {
    await trx
      .updateTable('auth_sessions')
      .set({ revoked_at: sql<Date>`now()`, revoke_reason: reason })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  private async revokeAll(
    trx: Tx,
    userId: string,
    except: string | null,
    reason: string,
  ): Promise<void> {
    let query = trx
      .updateTable('auth_sessions')
      .set({ revoked_at: sql<Date>`now()`, revoke_reason: reason })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null);
    if (except !== null) query = query.where('id', '<>', except);
    await query.execute();
  }

  /**
   * Crea un enlace de un solo uso y pide el correo (se envía tras confirmar). Más de
   * MAX_EMAILS_PER_HOUR por usuario y tipo en una hora no salen: nadie puede usar la API para
   * inundar el buzón de otro.
   */
  private async sendLink(
    trx: Tx,
    userId: string,
    email: string,
    kind: LinkKind,
    mails: AuthMail[],
  ): Promise<void> {
    const purpose = kind === VERIFY_EMAIL ? VERIFY_EMAIL : RESET_PASSWORD;
    // El count(*) no bloquea las altas de otras transacciones: sin ordenar por usuario, varias
    // peticiones simultáneas leerían el mismo contador y pasarían todas el cupo. Java tiene esta
    // carrera; el bloqueo solo la cierra.
    await trx.selectFrom('users').select('id').where('id', '=', userId).forUpdate().execute();
    const recent = await trx
      .selectFrom('user_tokens')
      .select(sql<string>`count(*)`.as('n'))
      .where('user_id', '=', userId)
      .where('purpose', '=', purpose)
      .where('created_at', '>', sql<Date>`now() - interval '1 hour'`)
      .executeTakeFirstOrThrow();
    if (Number(recent.n) >= MAX_EMAILS_PER_HOUR) {
      this.logger.warn(`auth.email.throttled user=${userId} kind=${kind}`);
      return;
    }
    const validForMs =
      purpose === VERIFY_EMAIL
        ? this.auth.verificationTtlMs
        : this.auth.resetTtlMs;
    const token = randomToken();
    await trx
      .insertInto('user_tokens')
      .values({
        user_id: userId,
        purpose,
        token_hash: sha256(token),
        expires_at: sql<Date>`now() + make_interval(secs => CAST(${seconds(validForMs)} AS double precision))`,
      })
      .execute();
    const web = this.auth.webUrl;
    switch (kind) {
      case VERIFY_EMAIL:
        mails.push(
          verificationMail(email, authLink(web, '/verify-email', token), validForMs),
        );
        break;
      case RESET_PASSWORD:
        mails.push(
          passwordResetMail(email, authLink(web, '/reset-password', token), validForMs),
        );
        break;
      default:
        mails.push(
          alreadyRegisteredMail(email, authLink(web, '/reset-password', token), validForMs),
        );
    }
  }

  /** Usa un enlace de un solo uso: devuelve su usuario o rechaza con 400 si no vale. */
  private async consume(
    trx: Tx,
    token: string,
    purpose: string,
  ): Promise<string> {
    const used = await trx
      .updateTable('user_tokens')
      .set({ used_at: sql<Date>`now()` })
      .where('token_hash', '=', sha256(token))
      .where('purpose', '=', purpose)
      .where('used_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .returning('user_id')
      .executeTakeFirst();
    if (used === undefined) {
      // No hay nada que confirmar: lanzar dentro de la transacción es lo correcto.
      throw new ApiException(
        400,
        'INVALID_LINK',
        'El enlace no es válido, ya se usó o caducó; pida uno nuevo',
      );
    }
    return used.user_id;
  }

  private async account(
    db: Kysely<DB> | Tx,
    email: string,
  ): Promise<Account | undefined> {
    const row = await db
      .selectFrom('users')
      .select(['id', 'email', 'password_hash', 'email_verified_at'])
      .where('email', '=', email)
      .executeTakeFirst();
    return row && toAccount(row);
  }

  private async accountById(db: Tx, id: string): Promise<Account | undefined> {
    const row = await db
      .selectFrom('users')
      .select(['id', 'email', 'password_hash', 'email_verified_at'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toAccount(row);
  }

  private async requireIpAllowed(clientIp: string | null): Promise<void> {
    const retryAfter = await this.limiter.ipRetryAfter(
      clientIp ?? 'desconocida',
    );
    if (retryAfter > 0) {
      throw ApiException.tooManyRequests(
        'RATE_LIMITED',
        'Demasiados intentos en poco tiempo; espere un momento',
        retryAfter,
      );
    }
  }

  private dispatch(mails: AuthMail[]): void {
    for (const mail of mails) this.mailer.send(mail);
  }
}

function toAccount(row: {
  id: string;
  email: string | null;
  password_hash: string | null;
  email_verified_at: Date | null;
}): Account {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
  };
}

function lockedError(retryAfterSeconds: number): ApiException {
  return ApiException.tooManyRequests(
    'ACCOUNT_LOCKED',
    'Demasiados intentos fallidos con este correo; espere unos minutos o cambie la contraseña',
    retryAfterSeconds,
  );
}

/** Segundos enteros de un plazo, como `Duration.toSeconds()`. */
function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** Longitud que la regla de la contraseña acepta; fuera de ella no vale la pena gastar Argon2. */
function isPlausibleLength(password: string): boolean {
  const length = codePointLength(password);
  return length >= 12 && length <= 128;
}
