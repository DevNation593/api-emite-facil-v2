import type { Request } from 'express';
import type { Kysely } from 'kysely';
import type { DB } from '../database/schema.js';
import {
  cachedUser,
  cacheUser,
  unauthenticated,
  type RequestIdentity,
  type UserIdentity,
} from './request-identity.js';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * La persona de una petición, leída de la base una sola vez por petición. Un token bien firmado
 * puede llevar un `sub` o un `sid` que no sean UUID (p. ej. firmado con otra clave de la misma
 * familia o con datos antiguos): se responde 401 antes de consultar, nunca un 500 de Postgres. Un
 * usuario que ya no existe tampoco entra. Es la única copia de estas reglas: la usan
 * CurrentUserGuard y TenantAccessGuard.
 */
export async function resolveUser(
  db: Kysely<DB>,
  req: Request,
  identity: Extract<RequestIdentity, { kind: 'user' }>,
): Promise<UserIdentity> {
  const cached = cachedUser(req);
  if (cached !== undefined) return cached;
  if (!UUID.test(identity.userId) || !UUID.test(identity.sessionId)) {
    throw unauthenticated();
  }
  const row = await db
    .selectFrom('users')
    .select(['id', 'email', 'email_verified_at'])
    .where('id', '=', identity.userId)
    .executeTakeFirst();
  if (row === undefined) throw unauthenticated();
  const user: UserIdentity = {
    userId: row.id,
    sessionId: identity.sessionId,
    email: row.email,
    emailVerified: row.email_verified_at !== null,
  };
  cacheUser(req, user);
  return user;
}
