import type { Kysely, Selectable, Transaction } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { strip } from '../common/java-text.js';
import type { AuditLog } from '../compliance/audit-log.js';
import type { DB, Taxpayers } from '../database/schema.js';
import { isUniqueViolation } from '../database/unique-violation.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';
import type { RimpeRegime } from './taxpayer.dto.js';

export type TaxpayerRow = Selectable<Taxpayers>;

/** Las propiedades de TaxpayerResponse de Java, en su orden. */
export interface TaxpayerView {
  id: string;
  ruc: string;
  legalName: string;
  tradeName: string | null;
  headOfficeAddress: string;
  phone: string | null;
  defaultEnvironment: string;
  accountingRequired: boolean;
  specialTaxpayerCode: string | null;
  withholdingAgentCode: string | null;
  rimpeRegime: RimpeRegime;
  productionEnabledAt: string | null;
}

/** Datos del alta; los fiscales son opcionales y llegan ya con sus valores por omisión. */
export interface CreateTaxpayerInput {
  ruc: string;
  legalName: string;
  tradeName: string | null;
  headOfficeAddress: string;
  phone: string | null;
  defaultEnvironment: string;
  accountingRequired: boolean;
  specialTaxpayerCode: string | null;
  withholdingAgentCode: string | null;
  rimpeRegime: RimpeRegime;
}

type Db = Kysely<DB> | Transaction<DB>;

/** En blanco es null; si no, el texto recortado (`blankToNull` de Java). */
export function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const stripped = strip(value);
  return stripped === '' ? null : stripped;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function taxpayerView(row: TaxpayerRow): TaxpayerView {
  return {
    id: row.id,
    ruc: row.ruc,
    legalName: row.legal_name,
    tradeName: row.trade_name,
    headOfficeAddress: row.head_office_address,
    phone: row.phone,
    defaultEnvironment: row.default_environment,
    accountingRequired: row.accounting_required,
    specialTaxpayerCode: row.special_taxpayer_code,
    withholdingAgentCode: row.withholding_agent_code,
    rimpeRegime: row.rimpe_regime as RimpeRegime,
    productionEnabledAt: iso(row.production_enabled_at as Date | string | null),
  };
}

/** Emisores: contribuyentes con RUC que facturan a través de la plataforma. Un RUC es de un solo tenant. */
export class TaxpayerService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly audit: AuditLog,
  ) {}

  create(access: TenantAccess, input: CreateTaxpayerInput): Promise<TaxpayerView> {
    access.requireWrite();
    if (input.rimpeRegime === 'NEGOCIO_POPULAR') {
      // El XSD de factura 1.1.0 incorporado solo admite la leyenda de RIMPE emprendedor: las
      // facturas de este emisor saldrían inválidas tras consumir su secuencial (docs/14).
      throw new ApiException(
        422,
        'RIMPE_REGIME_UNSUPPORTED',
        'Todavía no se pueden emitir comprobantes de contribuyentes RIMPE negocio popular',
      );
    }
    if (input.defaultEnvironment !== '1') {
      // Un emisor nace en pruebas; a producción se pasa con la activación (E6).
      throw new ApiException(
        422,
        'PRODUCTION_NOT_ENABLED',
        'Un emisor se da de alta en el ambiente de pruebas; el paso a producción se activa después',
      );
    }
    return this.db.transaction().execute(async (trx) => {
      let row: TaxpayerRow;
      try {
        row = await trx
          .insertInto('taxpayers')
          .values({
            tenant_id: access.tenantId,
            ruc: input.ruc,
            legal_name: strip(input.legalName),
            trade_name: blankToNull(input.tradeName),
            head_office_address: strip(input.headOfficeAddress),
            phone: blankToNull(input.phone),
            default_environment: input.defaultEnvironment,
            accounting_required: input.accountingRequired,
            special_taxpayer_code: input.specialTaxpayerCode,
            withholding_agent_code: input.withholdingAgentCode,
            rimpe_regime: input.rimpeRegime,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        // La restricción UNIQUE de la base decide, también cuando dos tenants registran a la vez.
        if (isUniqueViolation(error, 'taxpayers_ruc_key')) {
          throw new ApiException(409, 'RUC_ALREADY_REGISTERED', 'El RUC ya está registrado en la plataforma');
        }
        throw error;
      }
      await this.audit.recordFor(trx, access, 'TAXPAYER_CREATED', 'TAXPAYER', row.id, { ruc: input.ruc });
      return taxpayerView(row);
    });
  }

  async list(access: TenantAccess): Promise<TaxpayerView[]> {
    const rows = await this.db
      .selectFrom('taxpayers')
      .selectAll()
      .where('tenant_id', '=', access.tenantId)
      .orderBy('legal_name')
      .execute();
    return rows.map(taxpayerView);
  }

  /** Un emisor de otro tenant se trata igual que uno inexistente. */
  async get(access: TenantAccess, id: string): Promise<TaxpayerView> {
    return taxpayerView(await this.require(this.db, access.tenantId, id));
  }

  /** Cambia el teléfono (en blanco lo quita); vale para los comprobantes que se emitan desde ahora. */
  changePhone(access: TenantAccess, id: string, phone: string | null | undefined): Promise<TaxpayerView> {
    access.requireWrite();
    return this.db.transaction().execute(async (trx) => {
      await this.require(trx, access.tenantId, id);
      const row = await trx
        .updateTable('taxpayers')
        .set({ phone: blankToNull(phone) })
        .where('id', '=', id)
        .where('tenant_id', '=', access.tenantId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.recordFor(trx, access, 'TAXPAYER_UPDATED', 'TAXPAYER', id, { field: 'phone' });
      return taxpayerView(row);
    });
  }

  /** El emisor si es de esa empresa; null si no existe o es de otra. */
  async findForTenant(db: Db, tenantId: string, id: string): Promise<TaxpayerRow | null> {
    const row = await db
      .selectFrom('taxpayers')
      .selectAll()
      .where('id', '=', id)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    return row ?? null;
  }

  private async require(db: Db, tenantId: string, id: string): Promise<TaxpayerRow> {
    const row = await this.findForTenant(db, tenantId, id);
    if (row === null) throw ApiException.notFound();
    return row;
  }
}
