import type { Kysely } from 'kysely';
import type { DB } from '../database/schema.js';
import { isRole, type Role } from './tenant-access.js';

/** Una empresa vista por uno de sus miembros. */
export interface TenantView {
  id: string;
  name: string;
  status: string;
  role: Role;
}

/** Empresas en las que la persona tiene una membresía activa, con su rol en cada una. */
export async function findActiveTenantsOf(db: Kysely<DB>, userId: string): Promise<TenantView[]> {
  const rows = await db
    .selectFrom('memberships as m')
    .innerJoin('tenants as t', 't.id', 'm.tenant_id')
    .select(['t.id', 't.name', 't.status', 'm.role'])
    .where('m.user_id', '=', userId)
    .where('m.status', '=', 'ACTIVE')
    .orderBy('t.name')
    .orderBy('t.id')
    .execute();
  return rows.map((row) => {
    // La base lo restringe con un CHECK; si no cuadra, es un dato corrupto y no se concede acceso.
    if (!isRole(row.role)) throw new Error(`Rol desconocido en una membresía: ${row.role}`);
    return { id: row.id, name: row.name, status: row.status, role: row.role };
  });
}
