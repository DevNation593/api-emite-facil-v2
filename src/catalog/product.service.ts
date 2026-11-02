import { type Kysely, sql, type Transaction } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { formatDecimal, parseDecimal } from '../common/decimals.js';
import { strip } from '../common/java-text.js';
import { escapeLike } from '../common/like-terms.js';
import { type PageResponse, pageRequest } from '../common/pagination.js';
import type { AuditLog } from '../compliance/audit-log.js';
import type { DB } from '../database/schema.js';
import { isUniqueViolation } from '../database/unique-violation.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';
import type { CatalogRepository } from './catalog.repository.js';

/** Producto o servicio de un tenant. La tarifa de IVA es un código del catálogo, no un porcentaje. */
export interface ProductView {
  id: string;
  sku: string;
  name: string;
  /** Con 6 decimales. */
  unitPrice: string;
  ivaRateCode: string;
}

export interface ProductInput {
  sku: string;
  name: string;
  /** Ya validado contra QUANTITY_OR_PRICE. */
  unitPrice: string;
  ivaRateCode: string;
}

type Db = Kysely<DB> | Transaction<DB>;

const COLUMNS = ['id', 'sku', 'name', 'unit_price', 'iva_rate_code', 'version'] as const;

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  unit_price: string;
  iva_rate_code: string;
  version: string;
}

function view(row: ProductRow): ProductView {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    unitPrice: formatDecimal(row.unit_price, 6),
    ivaRateCode: row.iva_rate_code,
  };
}

const changed = () =>
  new ApiException(409, 'CATALOG_CHANGED', 'El producto cambió. Recargue la lista e inténtelo de nuevo');

function duplicateOrOriginal(error: unknown): unknown {
  if (isUniqueViolation(error, 'products_sku_key')) {
    return new ApiException(409, 'PRODUCT_SKU_TAKEN', 'Ya existe un producto con ese código');
  }
  return error;
}

/**
 * Productos de la empresa. Los crean OWNER, ADMIN y las API keys (requireProductCreation). Borrar es
 * archivar; las escrituras comprueban la versión que leyeron, como @Version de JPA.
 */
export class ProductService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly catalogs: CatalogRepository,
    private readonly audit: AuditLog,
  ) {}

  create(access: TenantAccess, input: ProductInput): Promise<ProductView> {
    access.requireProductCreation();
    return this.db.transaction().execute(async (trx) => {
      await this.validateRate(trx, input.ivaRateCode);
      let row: ProductRow;
      try {
        row = (await trx
          .insertInto('products')
          .values({ tenant_id: access.tenantId, ...this.columns(input) })
          .returning(COLUMNS)
          .executeTakeFirstOrThrow()) as ProductRow;
      } catch (error) {
        throw duplicateOrOriginal(error);
      }
      await this.audit.recordFor(trx, access, 'PRODUCT_CREATED', 'PRODUCT', row.id, { sku: input.sku });
      return view(row);
    });
  }

  update(access: TenantAccess, id: string, input: ProductInput): Promise<ProductView> {
    access.requireProductCreation();
    return this.db.transaction().execute(async (trx) => {
      const current = await this.require(trx, access.tenantId, id);
      await this.validateRate(trx, input.ivaRateCode);
      let row: ProductRow | undefined;
      try {
        row = (await trx
          .updateTable('products')
          .set({ ...this.columns(input), version: sql`version + 1` })
          .where('id', '=', id)
          .where('tenant_id', '=', access.tenantId)
          .where('version', '=', current.version)
          .where('deleted_at', 'is', null)
          .returning(COLUMNS)
          .executeTakeFirst()) as ProductRow | undefined;
      } catch (error) {
        throw duplicateOrOriginal(error);
      }
      if (row === undefined) throw changed();
      await this.audit.recordFor(trx, access, 'PRODUCT_UPDATED', 'PRODUCT', id, { sku: input.sku });
      return view(row);
    });
  }

  delete(access: TenantAccess, id: string): Promise<void> {
    access.requireProductCreation();
    return this.db.transaction().execute(async (trx) => {
      const current = await this.require(trx, access.tenantId, id);
      const archived = await trx
        .updateTable('products')
        .set({ deleted_at: sql`now()`, version: sql`version + 1` })
        .where('id', '=', id)
        .where('tenant_id', '=', access.tenantId)
        .where('version', '=', current.version)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (archived.numUpdatedRows === 0n) throw changed();
      await this.audit.recordFor(trx, access, 'PRODUCT_DELETED', 'PRODUCT', id, { sku: current.sku });
    });
  }

  /** Busca por nombre o código (contiene, sin distinguir mayúsculas). Ordena por nombre y código. */
  async search(access: TenantAccess, term: string, page: number, size: number): Promise<PageResponse<ProductView>> {
    const escaped = escapeLike(term);
    const request = pageRequest(page, size);
    let filtered = this.db
      .selectFrom('products')
      .where('tenant_id', '=', access.tenantId)
      .where('deleted_at', 'is', null);
    if (escaped !== '') {
      filtered = filtered.where((eb) =>
        eb.or([
          sql<boolean>`lower(name) LIKE lower('%' || ${escaped} || '%') ESCAPE '\\'`,
          sql<boolean>`lower(sku) LIKE lower('%' || ${escaped} || '%') ESCAPE '\\'`,
        ]),
      );
    }
    const [rows, total] = await Promise.all([
      filtered.select(COLUMNS).orderBy('name').orderBy('sku').limit(request.size).offset(request.offset).execute(),
      filtered.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return {
      items: (rows as ProductRow[]).map(view),
      page: request.page,
      size: request.size,
      total: Number(total.n),
    };
  }

  async get(access: TenantAccess, id: string): Promise<ProductView & { version: string }> {
    const row = await this.require(this.db, access.tenantId, id);
    return { ...view(row), version: row.version };
  }

  private columns(input: ProductInput) {
    return {
      sku: input.sku,
      name: strip(input.name),
      // numeric(18,6): se pasa el texto exacto, sin pasar por number.
      unit_price: parseDecimal(input.unitPrice, 12, 6).toFixed(),
      iva_rate_code: input.ivaRateCode,
    };
  }

  private async require(db: Db, tenantId: string, id: string): Promise<ProductRow> {
    const row = await db
      .selectFrom('products')
      .select(COLUMNS)
      .where('id', '=', id)
      .where('tenant_id', '=', tenantId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) throw ApiException.notFound();
    return row as ProductRow;
  }

  private async validateRate(db: Db, ivaRateCode: string): Promise<void> {
    if ((await this.catalogs.ivaRate(db, ivaRateCode)) === null) {
      throw new ApiException(422, 'TAX_RATE_UNKNOWN', 'La tarifa de IVA no existe en el catálogo');
    }
  }
}
