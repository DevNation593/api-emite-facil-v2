import type { Decimal } from 'decimal.js';
import { type Kysely, sql, type Transaction } from 'kysely';
import { BigDecimal } from '../common/big-decimal.js';
import { parseDecimal } from '../common/decimals.js';
import type { DB } from '../database/schema.js';

/** Código del IVA en la tabla 16 de la ficha. Identifica el impuesto, no una tarifa. */
export const IVA_TAX_CODE = '2';

export interface CodeName {
  code: string;
  name: string;
}

/** `idNumberPattern` es una expresión regular de Java que la identificación debe cumplir completa. */
export interface IdentificationType {
  code: string;
  name: string;
  idNumberPattern: string;
  finalConsumer: boolean;
}

/** Fechas YYYY-MM-DD, como LocalDate. */
export interface PaymentMethod {
  code: string;
  name: string;
  validFrom: string;
  validTo: string | null;
}

export interface TaxRate {
  taxCode: string;
  rateCode: string;
  description: string;
  rate: Decimal;
}

type Db = Kysely<DB> | Transaction<DB>;

/** `String.matches` de Java: la expresión debe cubrir el texto entero. */
export function matchesWhole(pattern: string, value: string): boolean {
  return new RegExp(`^(?:${pattern})$`, 'u').test(value);
}

/** numeric de PostgreSQL llega como texto; se lee sin perder dígitos. */
function decimal(value: string): Decimal {
  return parseDecimal(value, 1_000, 1_000);
}

/**
 * Catálogos tributarios del SRI. Son datos de la base, sembrados desde la ficha técnica: el código
 * de negocio pregunta aquí y nunca compara contra códigos o porcentajes escritos a mano.
 */
export class CatalogRepository {
  identificationTypes(db: Db): Promise<CodeName[]> {
    return db.selectFrom('identification_types').select(['code', 'name']).orderBy('code').execute();
  }

  async identificationType(db: Db, code: string): Promise<IdentificationType | null> {
    const row = await db
      .selectFrom('identification_types')
      .select(['code', 'name', 'id_number_pattern', 'final_consumer'])
      .where('code', '=', code)
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          code: row.code,
          name: row.name,
          idNumberPattern: row.id_number_pattern,
          finalConsumer: row.final_consumer,
        };
  }

  /** Indica si la identificación es la reservada para ventas a consumidor final. */
  async isFinalConsumerNumber(db: Db, idNumber: string): Promise<boolean> {
    const patterns = await db
      .selectFrom('identification_types')
      .select('id_number_pattern')
      .where('final_consumer', '=', true)
      .execute();
    return patterns.some((row) => matchesWhole(row.id_number_pattern, idNumber));
  }

  async paymentMethods(db: Db): Promise<PaymentMethod[]> {
    const rows = await db
      .selectFrom('payment_methods')
      .select(['code', 'name', 'valid_from', 'valid_to'])
      .orderBy('code')
      .execute();
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    }));
  }

  async paymentMethodValidOn(db: Db, code: string, date: string): Promise<boolean> {
    // Un LocalDate del año 0 o anterior (un día de época muy negativo) es anterior a toda vigencia, y
    // PostgreSQL no lo leería: se responde sin preguntar.
    if (date.startsWith('-') || date.startsWith('0000-')) return false;
    const row = await db
      .selectFrom('payment_methods')
      .select(sql<string>`count(*)`.as('n'))
      .where('code', '=', code)
      .where('valid_from', '<=', date)
      .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', date)]))
      .executeTakeFirstOrThrow();
    return Number(row.n) > 0;
  }

  async taxRates(db: Db): Promise<TaxRate[]> {
    const rows = await db
      .selectFrom('tax_rates')
      .select(['tax_code', 'rate_code', 'description', 'rate'])
      .orderBy('tax_code')
      .orderBy(sql`CAST(rate_code AS integer)`)
      .execute();
    return rows.map((row) => ({
      taxCode: row.tax_code,
      rateCode: row.rate_code,
      description: row.description,
      rate: decimal(String(row.rate)),
    }));
  }

  /** Porcentaje de la tarifa con la escala 2 de la columna (15.00), como el BigDecimal de JDBC. */
  async ivaRate(db: Db, rateCode: string): Promise<BigDecimal | null> {
    const row = await db
      .selectFrom('tax_rates')
      .select('rate')
      .where('tax_code', '=', IVA_TAX_CODE)
      .where('rate_code', '=', rateCode)
      .executeTakeFirst();
    return row === undefined ? null : BigDecimal.of(String(row.rate));
  }
}
