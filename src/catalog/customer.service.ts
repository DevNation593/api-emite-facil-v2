import { type Kysely, sql, type Transaction } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { strip } from '../common/java-text.js';
import { escapeLike } from '../common/like-terms.js';
import { type PageResponse, pageRequest } from '../common/pagination.js';
import type { AuditLog } from '../compliance/audit-log.js';
import type { DB } from '../database/schema.js';
import { isUniqueViolation } from '../database/unique-violation.js';
import { blankToNull } from '../taxpayer/taxpayer.service.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';
import { type CatalogRepository, matchesWhole } from './catalog.repository.js';

/** Cliente (adquirente) de un tenant, identificado por tipo y número según la tabla 6 de la ficha. */
export interface CustomerView {
  id: string;
  idType: string;
  idNumber: string;
  name: string;
  email: string | null;
  address: string | null;
  phone: string | null;
}

export interface CustomerInput {
  idType: string;
  idNumber: string;
  name: string;
  email?: string | null;
  address?: string | null;
  phone?: string | null;
}

type Db = Kysely<DB> | Transaction<DB>;

const COLUMNS = ['id', 'id_type', 'id_number', 'name', 'email', 'address', 'phone', 'version'] as const;

interface CustomerRow {
  id: string;
  id_type: string;
  id_number: string;
  name: string;
  email: string | null;
  address: string | null;
  phone: string | null;
  version: string;
}

function view(row: CustomerRow): CustomerView {
  return {
    id: row.id,
    idType: row.id_type,
    idNumber: row.id_number,
    name: row.name,
    email: row.email,
    address: row.address,
    phone: row.phone,
  };
}

const changed = () =>
  new ApiException(409, 'CATALOG_CHANGED', 'El cliente cambió. Recargue la lista e inténtelo de nuevo');

function duplicateOrOriginal(error: unknown): unknown {
  if (isUniqueViolation(error, 'customers_identification_key')) {
    return new ApiException(409, 'CUSTOMER_ALREADY_EXISTS', 'Ya existe un cliente con esa identificación');
  }
  return error;
}

/**
 * Clientes de la empresa. Borrar es archivar (deleted_at). Las escrituras comprueban la versión que
 * leyeron, como @Version de JPA: si otra petición cambió o borró el cliente entre medias, 409.
 */
export class CustomerService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly catalogs: CatalogRepository,
    private readonly audit: AuditLog,
  ) {}

  create(access: TenantAccess, input: CustomerInput): Promise<CustomerView> {
    access.requireBilling();
    return this.db.transaction().execute(async (trx) => {
      await this.validateIdentification(trx, input.idType, input.idNumber);
      let row: CustomerRow;
      try {
        row = (await trx
          .insertInto('customers')
          .values({ tenant_id: access.tenantId, ...this.columns(input) })
          .returning(COLUMNS)
          .executeTakeFirstOrThrow()) as CustomerRow;
      } catch (error) {
        throw duplicateOrOriginal(error);
      }
      // La bitácora no guarda datos personales: basta el tipo de identificación.
      await this.audit.recordFor(trx, access, 'CUSTOMER_CREATED', 'CUSTOMER', row.id, { idType: input.idType });
      return view(row);
    });
  }

  update(access: TenantAccess, id: string, input: CustomerInput): Promise<CustomerView> {
    access.requireBilling();
    return this.db.transaction().execute(async (trx) => {
      const current = await this.require(trx, access.tenantId, id);
      await this.validateIdentification(trx, input.idType, input.idNumber);
      let row: CustomerRow | undefined;
      try {
        row = (await trx
          .updateTable('customers')
          .set({ ...this.columns(input), version: sql`version + 1` })
          .where('id', '=', id)
          .where('tenant_id', '=', access.tenantId)
          .where('version', '=', current.version)
          .where('deleted_at', 'is', null)
          .returning(COLUMNS)
          .executeTakeFirst()) as CustomerRow | undefined;
      } catch (error) {
        throw duplicateOrOriginal(error);
      }
      if (row === undefined) throw changed();
      await this.audit.recordFor(trx, access, 'CUSTOMER_UPDATED', 'CUSTOMER', id, { idType: input.idType });
      return view(row);
    });
  }

  delete(access: TenantAccess, id: string): Promise<void> {
    access.requireBilling();
    return this.db.transaction().execute(async (trx) => {
      const current = await this.require(trx, access.tenantId, id);
      const archived = await trx
        .updateTable('customers')
        .set({ deleted_at: sql`now()`, version: sql`version + 1` })
        .where('id', '=', id)
        .where('tenant_id', '=', access.tenantId)
        .where('version', '=', current.version)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (archived.numUpdatedRows === 0n) throw changed();
      await this.audit.recordFor(trx, access, 'CUSTOMER_DELETED', 'CUSTOMER', id, { idType: current.id_type });
    });
  }

  /**
   * Busca por nombre (contiene, sin distinguir mayúsculas) o por identificación (empieza por). Vacío
   * devuelve todos. Ordena por nombre e id.
   */
  async search(access: TenantAccess, term: string, page: number, size: number): Promise<PageResponse<CustomerView>> {
    // Como Java: la página se valida antes que el término.
    const request = pageRequest(page, size);
    const escaped = escapeLike(term);
    let filtered = this.db
      .selectFrom('customers')
      .where('tenant_id', '=', access.tenantId)
      .where('deleted_at', 'is', null);
    if (escaped !== '') {
      filtered = filtered.where((eb) =>
        eb.or([
          sql<boolean>`lower(name) LIKE lower('%' || ${escaped} || '%') ESCAPE '\\'`,
          sql<boolean>`id_number LIKE ${escaped} || '%' ESCAPE '\\'`,
        ]),
      );
    }
    const [rows, total] = await Promise.all([
      filtered.select(COLUMNS).orderBy('name').orderBy('id').limit(request.size).offset(request.offset).execute(),
      filtered.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return {
      items: (rows as CustomerRow[]).map(view),
      page: request.page,
      size: request.size,
      total: Number(total.n),
    };
  }

  async get(access: TenantAccess, id: string): Promise<CustomerView & { version: string }> {
    const row = await this.require(this.db, access.tenantId, id);
    return { ...view(row), version: row.version };
  }

  private columns(input: CustomerInput) {
    return {
      id_type: input.idType,
      id_number: input.idNumber,
      name: strip(input.name),
      email: blankToNull(input.email),
      address: blankToNull(input.address),
      phone: blankToNull(input.phone),
    };
  }

  private async require(db: Db, tenantId: string, id: string): Promise<CustomerRow> {
    const row = await db
      .selectFrom('customers')
      .select(COLUMNS)
      .where('id', '=', id)
      .where('tenant_id', '=', tenantId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) throw ApiException.notFound();
    return row as CustomerRow;
  }

  private async validateIdentification(db: Db, idType: string, idNumber: string): Promise<void> {
    const type = await this.catalogs.identificationType(db, idType);
    if (type === null) {
      throw new ApiException(
        422,
        'IDENTIFICATION_TYPE_UNKNOWN',
        'El tipo de identificación no existe en el catálogo',
      );
    }
    // Si no, el monto máximo de consumidor final se evitaría registrando esos mismos dígitos como RUC.
    const borrowsFinalConsumerNumber = !type.finalConsumer && (await this.catalogs.isFinalConsumerNumber(db, idNumber));
    if (!matchesWhole(type.idNumberPattern, idNumber) || borrowsFinalConsumerNumber) {
      throw new ApiException(422, 'IDENTIFICATION_INVALID', 'La identificación no tiene el formato de su tipo');
    }
  }
}
