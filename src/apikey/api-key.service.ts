import { randomUUID } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { codePointLength, strip } from '../common/java-text.js';
import type { AuditLog } from '../compliance/audit-log.js';
import type { DB } from '../database/schema.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';
import { apiKeySecretMatches, generateApiKey, parseApiKey } from './api-key-credential.js';

/** La key ya comprobada: a qué empresa pertenece y en nombre de quién actúa. */
export interface ApiKeyPrincipal {
  apiKeyId: string;
  tenantId: string;
  createdBy: string;
}

/**
 * Una key en la lista: nunca trae el secreto. `createdBy` es el correo de quien la creó; null si
 * la cuenta no tiene correo (las migradas sin uno válido, V15).
 */
export interface ApiKeyView {
  id: string;
  name: string;
  publicId: string;
  createdBy: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** La key recién creada. `key` es el valor completo: es la única vez que se entrega. */
export interface CreatedApiKey {
  id: string;
  name: string;
  publicId: string;
  key: string;
  createdAt: Date;
}

/** Máximo de keys activas por empresa. */
export const MAX_ACTIVE_API_KEYS = 10;
/** Largo máximo del nombre, ya recortado, en puntos de código. */
export const MAX_API_KEY_NAME_LENGTH = 80;

const ACTIVE_NAME_INDEX = 'uq_api_keys_active_name';

/** Violación de unicidad (23505) del índice de nombres activos. */
function isActiveNameTaken(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === '23505' && constraint === ACTIVE_NAME_INDEX;
}

/**
 * El nombre se recorta, también de espacios Unicode que @NotBlank de Java no ve (un nombre hecho
 * solo de U+3000), y el largo se mide después de recortar: así nunca llega a la base un nombre que
 * su CHECK rechazaría con un 500.
 */
function validName(name: string): string {
  const trimmed = strip(name);
  const length = codePointLength(trimmed);
  if (length === 0 || length > MAX_API_KEY_NAME_LENGTH) {
    throw new ApiException(400, 'VALIDATION_FAILED', 'La petición no cumple las reglas de validación', [
      {
        field: 'name',
        message: `debe tener entre 1 y ${MAX_API_KEY_NAME_LENGTH} caracteres sin contar los espacios de los extremos`,
      },
    ]);
  }
  return trimmed;
}

/**
 * API keys de una empresa: crear, listar y revocar (solo OWNER y ADMIN), y comprobar la key que
 * presenta un sistema externo (X-Api-Key). El valor completo de una key sale una vez, en la
 * respuesta de creación; ni él ni su hash llegan a la auditoría ni a los registros.
 */
export class ApiKeyService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly audit: AuditLog,
  ) {}

  async create(access: TenantAccess, name: string): Promise<CreatedApiKey> {
    access.requireWrite();
    const trimmed = validName(name);
    try {
      return await this.db.transaction().execute(async (trx) => {
        // Serializa las altas de la empresa para que el tope se decida de una en una.
        await trx
          .selectFrom('tenants')
          .select('id')
          .where('id', '=', access.tenantId)
          .forUpdate()
          .execute();
        const { active } = await trx
          .selectFrom('api_keys')
          .select((eb) => eb.fn.countAll().as('active'))
          .where('tenant_id', '=', access.tenantId)
          .where('revoked_at', 'is', null)
          .executeTakeFirstOrThrow();
        if (Number(active) >= MAX_ACTIVE_API_KEYS) {
          throw new ApiException(
            409,
            'API_KEY_LIMIT',
            'La empresa ya tiene el máximo de API keys activas; revoque alguna',
          );
        }
        const generated = generateApiKey();
        const id = randomUUID();
        const { created_at: createdAt } = await trx
          .insertInto('api_keys')
          .values({
            id,
            tenant_id: access.tenantId,
            created_by: access.userId,
            name: trimmed,
            public_id: generated.publicId,
            secret_hash: generated.secretHash,
          })
          .returning('created_at')
          .executeTakeFirstOrThrow();
        await this.audit.recordFor(trx, access, 'API_KEY_CREATED', 'API_KEY', id, {
          name: trimmed,
        });
        return { id, name: trimmed, publicId: generated.publicId, key: generated.value, createdAt };
      });
    } catch (error) {
      // La transacción ya se deshizo: solo queda responder.
      if (isActiveNameTaken(error)) {
        throw new ApiException(409, 'API_KEY_NAME_TAKEN', 'Ya hay una API key activa con ese nombre');
      }
      throw error;
    }
  }

  /** Las keys de la empresa, también las revocadas: primero las activas y luego la más nueva. */
  async list(access: TenantAccess): Promise<ApiKeyView[]> {
    access.requireWrite();
    const rows = await this.db
      .selectFrom('api_keys as k')
      .innerJoin('users as u', 'u.id', 'k.created_by')
      .select([
        'k.id',
        'k.name',
        'k.public_id',
        'u.email',
        'k.created_at',
        'k.last_used_at',
        'k.revoked_at',
      ])
      .where('k.tenant_id', '=', access.tenantId)
      .orderBy(sql`(k.revoked_at IS NOT NULL)`)
      .orderBy('k.created_at', 'desc')
      .orderBy('k.id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      publicId: row.public_id,
      createdBy: row.email,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }));
  }

  /** Revocar una key ya revocada no cambia nada ni se audita; una que no es de la empresa es 404. */
  async revoke(access: TenantAccess, id: string): Promise<void> {
    access.requireWrite();
    await this.db.transaction().execute(async (trx) => {
      const revoked = await trx
        .updateTable('api_keys')
        .set({ revoked_at: sql<Date>`now()`, revoked_by: access.userId })
        .where('id', '=', id)
        .where('tenant_id', '=', access.tenantId)
        .where('revoked_at', 'is', null)
        .returning('name')
        .execute();
      if (revoked.length === 0) {
        const exists = await trx
          .selectFrom('api_keys')
          .select('id')
          .where('id', '=', id)
          .where('tenant_id', '=', access.tenantId)
          .executeTakeFirst();
        if (exists === undefined) {
          throw new ApiException(404, 'API_KEY_NOT_FOUND', 'La API key no existe');
        }
        return;
      }
      await this.audit.recordFor(trx, access, 'API_KEY_REVOKED', 'API_KEY', id, {
        name: revoked[0]!.name,
      });
    });
  }

  /**
   * Null si el formato no vale (sin consultar la base), si la key no existe, si el secreto no
   * coincide o si está revocada: quien llama no distingue entre esos casos. Sin caché: una key
   * revocada deja de servir en la petición siguiente. Un fallo de la base se propaga.
   */
  async authenticate(header: string): Promise<ApiKeyPrincipal | null> {
    const presented = parseApiKey(header);
    if (presented === null) return null;
    const stored = await this.db
      .selectFrom('api_keys')
      .select(['id', 'tenant_id', 'created_by', 'secret_hash'])
      .where('public_id', '=', presented.publicId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (stored === undefined || !apiKeySecretMatches(presented.secret, stored.secret_hash)) {
      return null;
    }
    return { apiKeyId: stored.id, tenantId: stored.tenant_id, createdBy: stored.created_by };
  }

  /** Anota el último uso, como mucho una escritura por minuto y key. */
  async touch(apiKeyId: string): Promise<void> {
    await this.db
      .updateTable('api_keys')
      .set({ last_used_at: sql<Date>`now()` })
      .where('id', '=', apiKeyId)
      .where((eb) =>
        eb.or([
          eb('last_used_at', 'is', null),
          eb('last_used_at', '<', sql<Date>`now() - interval '1 minute'`),
        ]),
      )
      .execute();
  }
}
