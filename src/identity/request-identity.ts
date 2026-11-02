import type { Request } from 'express';
import { ApiException } from '../common/api-exception.js';

/** Quién hace la petición: una persona con su sesión, o un sistema externo con una API key. */
export type RequestIdentity =
  | { kind: 'user'; userId: string; sessionId: string }
  | { kind: 'apiKey'; apiKeyId: string; tenantId: string; createdBy: string };

/** La persona de la petición, con los datos de su cuenta leídos de la base. */
export interface UserIdentity {
  userId: string;
  sessionId: string;
  email: string | null;
  emailVerified: boolean;
}

const IDENTITY = Symbol('einvoice.requestIdentity');
const USER = Symbol('einvoice.userIdentity');
type Carrier = Request & {
  [IDENTITY]?: RequestIdentity;
  [USER]?: UserIdentity;
};

export const UNAUTHENTICATED_DETAIL = 'Se requiere un token de acceso válido';

export function unauthenticated(): ApiException {
  return new ApiException(401, 'UNAUTHENTICATED', UNAUTHENTICATED_DETAIL);
}

export function setIdentity(req: Request, identity: RequestIdentity): void {
  (req as Carrier)[IDENTITY] = identity;
}

/** La identidad que dejó el middleware de autenticación; 401 si la petición no pasó por él. */
export function identityOf(req: Request): RequestIdentity {
  const identity = (req as Carrier)[IDENTITY];
  if (identity === undefined) throw unauthenticated();
  return identity;
}

/** Una sola lectura de la cuenta por petición, aunque varios parámetros la pidan. */
export function cachedUser(req: Request): UserIdentity | undefined {
  return (req as Carrier)[USER];
}

export function cacheUser(req: Request, user: UserIdentity): void {
  (req as Carrier)[USER] = user;
}
