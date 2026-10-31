import type { Kysely } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { strip } from '../common/java-text.js';
import type { AuditLog } from '../compliance/audit-log.js';
import type { DB } from '../database/schema.js';
import type { UserIdentity } from '../identity/request-identity.js';
import { findActiveTenantsOf, type TenantView } from './memberships.js';
import type { TenantAccess } from './tenant-access.js';

export class TenantService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly audit: AuditLog,
  ) {}

  /** Crea la empresa y deja a quien la crea como su propietario, con su evento de auditoría. */
  create(user: UserIdentity, name: string): Promise<TenantView> {
    return this.db.transaction().execute(async (trx) => {
      const tenant = await trx
        .insertInto('tenants')
        .values({ name: strip(name) })
        .returning(['id', 'name', 'status'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('memberships')
        .values({ user_id: user.userId, tenant_id: tenant.id, role: 'OWNER' })
        .execute();
      await this.audit.record(trx, tenant.id, user.userId, 'TENANT_CREATED', 'TENANT', tenant.id, {
        name: tenant.name,
      });
      return { id: tenant.id, name: tenant.name, status: tenant.status, role: 'OWNER' };
    });
  }

  listFor(user: UserIdentity): Promise<TenantView[]> {
    return findActiveTenantsOf(this.db, user.userId);
  }

  async current(access: TenantAccess): Promise<TenantView> {
    const tenant = await this.db
      .selectFrom('tenants')
      .select(['id', 'name', 'status'])
      .where('id', '=', access.tenantId)
      .executeTakeFirst();
    if (tenant === undefined) throw ApiException.notFound();
    return { id: tenant.id, name: tenant.name, status: tenant.status, role: access.role };
  }
}
