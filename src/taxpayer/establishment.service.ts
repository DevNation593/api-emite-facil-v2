import type { Kysely, Transaction } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { strip } from '../common/java-text.js';
import type { AuditLog } from '../compliance/audit-log.js';
import type { DB } from '../database/schema.js';
import { isUniqueViolation } from '../database/unique-violation.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';
import type { TaxpayerService } from './taxpayer.service.js';

/** Establecimiento de un emisor. El código es texto de 3 dígitos, tal como va en el comprobante. */
export interface EstablishmentView {
  id: string;
  taxpayerId: string;
  code: string;
  address: string;
}

/** Punto de emisión de un establecimiento. El código es texto de 3 dígitos. */
export interface EmissionPointView {
  id: string;
  establishmentId: string;
  code: string;
  enabled: boolean;
}

type Db = Kysely<DB> | Transaction<DB>;

/** Establecimientos y puntos de emisión. El emisor o establecimiento padre se busca siempre dentro del tenant. */
export class EstablishmentService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly audit: AuditLog,
    private readonly taxpayers: TaxpayerService,
  ) {}

  createEstablishment(
    access: TenantAccess,
    taxpayerId: string,
    code: string,
    address: string,
  ): Promise<EstablishmentView> {
    access.requireWrite();
    return this.db.transaction().execute(async (trx) => {
      const taxpayer = await this.taxpayers.findForTenant(trx, access.tenantId, taxpayerId);
      if (taxpayer === null) throw ApiException.notFound();
      let row;
      try {
        row = await trx
          .insertInto('establishments')
          .values({ tenant_id: access.tenantId, taxpayer_id: taxpayer.id, code, address: strip(address) })
          .returning(['id', 'taxpayer_id', 'code', 'address'])
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error, 'establishments_taxpayer_id_code_key')) {
          throw new ApiException(
            409,
            'ESTABLISHMENT_CODE_TAKEN',
            'El emisor ya tiene un establecimiento con ese código',
          );
        }
        throw error;
      }
      await this.audit.recordFor(trx, access, 'ESTABLISHMENT_CREATED', 'ESTABLISHMENT', row.id, {
        taxpayerId: taxpayer.id,
        code,
      });
      return { id: row.id, taxpayerId: row.taxpayer_id, code: row.code, address: row.address };
    });
  }

  async listEstablishments(access: TenantAccess, taxpayerId: string): Promise<EstablishmentView[]> {
    const taxpayer = await this.taxpayers.findForTenant(this.db, access.tenantId, taxpayerId);
    if (taxpayer === null) throw ApiException.notFound();
    const rows = await this.db
      .selectFrom('establishments')
      .select(['id', 'taxpayer_id', 'code', 'address'])
      .where('taxpayer_id', '=', taxpayer.id)
      .where('tenant_id', '=', access.tenantId)
      .orderBy('code')
      .execute();
    return rows.map((row) => ({ id: row.id, taxpayerId: row.taxpayer_id, code: row.code, address: row.address }));
  }

  createEmissionPoint(access: TenantAccess, establishmentId: string, code: string): Promise<EmissionPointView> {
    access.requireWrite();
    return this.db.transaction().execute(async (trx) => {
      const establishment = await this.establishment(trx, access, establishmentId);
      let row;
      try {
        row = await trx
          .insertInto('emission_points')
          .values({ tenant_id: access.tenantId, establishment_id: establishment, code })
          .returning(['id', 'establishment_id', 'code', 'enabled'])
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error, 'emission_points_establishment_id_code_key')) {
          throw new ApiException(
            409,
            'EMISSION_POINT_CODE_TAKEN',
            'El establecimiento ya tiene un punto de emisión con ese código',
          );
        }
        throw error;
      }
      await this.audit.recordFor(trx, access, 'EMISSION_POINT_CREATED', 'EMISSION_POINT', row.id, {
        establishmentId: establishment,
        code,
      });
      return { id: row.id, establishmentId: row.establishment_id, code: row.code, enabled: row.enabled };
    });
  }

  async listEmissionPoints(access: TenantAccess, establishmentId: string): Promise<EmissionPointView[]> {
    const establishment = await this.establishment(this.db, access, establishmentId);
    const rows = await this.db
      .selectFrom('emission_points')
      .select(['id', 'establishment_id', 'code', 'enabled'])
      .where('establishment_id', '=', establishment)
      .where('tenant_id', '=', access.tenantId)
      .orderBy('code')
      .execute();
    return rows.map((row) => ({ id: row.id, establishmentId: row.establishment_id, code: row.code, enabled: row.enabled }));
  }

  /** El id del establecimiento si es de la empresa; 404 si no existe o es de otra. */
  private async establishment(db: Db, access: TenantAccess, id: string): Promise<string> {
    const row = await db
      .selectFrom('establishments')
      .select('id')
      .where('id', '=', id)
      .where('tenant_id', '=', access.tenantId)
      .executeTakeFirst();
    if (row === undefined) throw ApiException.notFound();
    return row.id;
  }
}
