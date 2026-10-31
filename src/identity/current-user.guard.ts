import {
  type CanActivate,
  type ExecutionContext,
  createParamDecorator,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Kysely } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import {
  cachedUser,
  cacheUser,
  identityOf,
  unauthenticated,
  type UserIdentity,
} from './request-identity.js';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Los endpoints de una persona (cuenta, empresas propias): una API key no es una persona (403), y
 * el token de un usuario que ya no existe no sirve, por bien firmado que esté. Lee la cuenta de la
 * base para tener el correo y su verificación al día. Un módulo que lo use con @UseGuards debe
 * poder inyectar DATABASE (importar DatabaseModule).
 */
@Injectable()
export class CurrentUserGuard implements CanActivate {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (cachedUser(req) !== undefined) return true;
    const identity = identityOf(req);
    if (identity.kind === 'apiKey') {
      throw new ApiException(
        403,
        'API_KEY_NOT_ALLOWED',
        'Esta operación solo la hace una persona, no una API key',
      );
    }
    if (!UUID.test(identity.userId) || !UUID.test(identity.sessionId)) {
      throw unauthenticated();
    }
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'email', 'email_verified_at'])
      .where('id', '=', identity.userId)
      .executeTakeFirst();
    if (row === undefined) throw unauthenticated();
    cacheUser(req, {
      userId: row.id,
      sessionId: identity.sessionId,
      email: row.email,
      emailVerified: row.email_verified_at !== null,
    });
    return true;
  }
}

/** La persona autenticada; el endpoint debe llevar `@UseGuards(CurrentUserGuard)`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UserIdentity => {
    const user = cachedUser(context.switchToHttp().getRequest<Request>());
    if (user === undefined) throw unauthenticated();
    return user;
  },
);
