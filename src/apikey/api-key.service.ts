import { type Kysely, sql } from 'kysely';
import type { DB } from '../database/schema.js';
import { apiKeySecretMatches, parseApiKey } from './api-key-credential.js';

/** La key ya comprobada: a qué empresa pertenece y en nombre de quién actúa. */
export interface ApiKeyPrincipal {
  apiKeyId: string;
  tenantId: string;
  createdBy: string;
}

/**
 * Comprobación de la API key que presenta un sistema externo (X-Api-Key). Crear, listar y revocar
 * llegan con la Task 7. El valor de la key no se registra en ningún sitio.
 */
export class ApiKeyService {
  constructor(private readonly db: Kysely<DB>) {}

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
