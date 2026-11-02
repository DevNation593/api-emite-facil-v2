import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Kysely } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { identityOf, unauthenticated } from '../identity/request-identity.js';
import { resolveUser } from '../identity/user-resolution.js';
import { findActiveTenantsOf, type TenantView } from './memberships.js';
import {
  API_KEY_ROLE,
  canBill,
  parseTenantHeader,
  setTenantAccess,
  TENANT_HEADER,
  TenantAccess,
} from './tenant-access.js';

const tenantForbidden = () =>
  new ApiException(403, 'TENANT_FORBIDDEN', 'Sin acceso al tenant indicado');

/** La cabecera como texto, o undefined si falta o está en blanco (cuenta como ausente). */
function headerValue(req: Request): string | undefined {
  const raw = req.headers[TENANT_HEADER.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') return undefined;
  return value;
}

/**
 * Fija la empresa activa de la petición. Con la sesión de una persona, sale de X-Tenant-Id solo si
 * tiene una membresía activa en una empresa activa (una ajena y una inexistente responden igual);
 * sin cabecera vale su única empresa. Con una API key, es la de la key.
 *
 * Un módulo de dominio solo necesita importar TenancyModule y usar `@UseGuards(TenantAccessGuard)`
 * con `@Tenant()`; el guard se instancia en ese módulo, que por eso debe poder inyectar DATABASE
 * (TenancyModule lo reexporta).
 */
@Injectable()
export class TenantAccessGuard implements CanActivate {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const identity = identityOf(req);
    const header = headerValue(req);
    if (identity.kind === 'apiKey') {
      setTenantAccess(req, await this.forApiKey(identity, header));
      return true;
    }
    const user = await resolveUser(this.db, req, identity);
    const usable = (await findActiveTenantsOf(this.db, user.userId)).filter(
      (tenant) => tenant.status === 'ACTIVE',
    );
    if (header === undefined) {
      setTenantAccess(req, withoutHeader(user.userId, usable));
      return true;
    }
    const requested = parseTenantHeader(header);
    const tenant = usable.find((t) => t.id.toLowerCase() === requested);
    if (tenant === undefined) throw tenantForbidden();
    setTenantAccess(req, new TenantAccess(user.userId, tenant.id, tenant.role));
    return true;
  }

  /**
   * La empresa es la de la key; X-Tenant-Id es opcional y, si viene, tiene que ser esa. La key solo
   * sirve mientras la empresa esté activa y su creador siga en ella con un rol que factura; si no,
   * responde como una key inválida. El rol es siempre API_KEY_ROLE, sea cual sea el del creador.
   */
  private async forApiKey(
    key: { apiKeyId: string; tenantId: string; createdBy: string },
    header: string | undefined,
  ): Promise<TenantAccess> {
    if (header !== undefined && parseTenantHeader(header) !== key.tenantId.toLowerCase()) {
      throw tenantForbidden();
    }
    const creatorCanBill = (await findActiveTenantsOf(this.db, key.createdBy)).some(
      (tenant) =>
        tenant.id === key.tenantId && tenant.status === 'ACTIVE' && canBill(tenant.role),
    );
    if (!creatorCanBill) throw unauthenticated();
    return new TenantAccess(key.createdBy, key.tenantId, API_KEY_ROLE, key.apiKeyId);
  }
}

function withoutHeader(userId: string, usable: TenantView[]): TenantAccess {
  if (usable.length === 0) {
    throw new ApiException(
      403,
      'TENANT_FORBIDDEN',
      'El usuario no pertenece a ningún tenant activo',
    );
  }
  if (usable.length > 1) {
    throw new ApiException(
      400,
      'TENANT_REQUIRED',
      `El usuario pertenece a varios tenants; indique uno en la cabecera ${TENANT_HEADER}`,
    );
  }
  const only = usable[0]!;
  return new TenantAccess(userId, only.id, only.role);
}
