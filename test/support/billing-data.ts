import { randomInt } from 'node:crypto';
import type pg from 'pg';
import type { BigDecimal } from '../../src/common/big-decimal.js';
import { randomRuc } from './scenario.js';

// Traducción de support/TestData.java: inserciones directas para preparar escenarios.

async function id(
  db: pg.Client,
  text: string,
  params: unknown[],
): Promise<string> {
  return ((await db.query(text, params)).rows[0] as { id: string }).id;
}

export const newTenant = (db: pg.Client) =>
  id(db, 'INSERT INTO tenants (name) VALUES ($1) RETURNING id', [
    `Empresa ${randomInt(1e9)}`,
  ]);

export const newUser = (db: pg.Client) =>
  id(db, 'INSERT INTO users (email) VALUES ($1) RETURNING id', [
    `u-${randomInt(1e9)}-${Date.now()}@example.test`,
  ]);

export const newTaxpayer = (
  db: pg.Client,
  tenant: string,
  ruc: string = randomRuc(),
) =>
  id(
    db,
    `INSERT INTO taxpayers (tenant_id, ruc, legal_name, head_office_address, default_environment)
     VALUES ($1, $2, 'Emisor de prueba', 'Quito', '1') RETURNING id`,
    [tenant, ruc],
  );

export const newEstablishment = (
  db: pg.Client,
  tenant: string,
  taxpayer: string,
  code: string,
) =>
  id(
    db,
    "INSERT INTO establishments (tenant_id, taxpayer_id, code, address) VALUES ($1, $2, $3, 'Quito') RETURNING id",
    [tenant, taxpayer, code],
  );

export const newEmissionPoint = (
  db: pg.Client,
  tenant: string,
  establishment: string,
  code: string,
) =>
  id(
    db,
    'INSERT INTO emission_points (tenant_id, establishment_id, code) VALUES ($1, $2, $3) RETURNING id',
    [tenant, establishment, code],
  );

export const newCustomer = (
  db: pg.Client,
  tenant: string,
  idType: string,
  idNumber: string,
) =>
  id(
    db,
    "INSERT INTO customers (tenant_id, id_type, id_number, name) VALUES ($1, $2, $3, 'Cliente de prueba') RETURNING id",
    [tenant, idType, idNumber],
  );

export const newProduct = (
  db: pg.Client,
  tenant: string,
  sku: string,
  ivaRateCode: string,
) =>
  id(
    db,
    `INSERT INTO products (tenant_id, sku, name, unit_price, iva_rate_code)
     VALUES ($1, $2, 'Producto de prueba', 10, $3) RETURNING id`,
    [tenant, sku, ivaRateCode],
  );

/** Clave de acceso sintáctica (49 dígitos) para pruebas de esquema; no pretende ser válida. */
export function randomAccessKey(): string {
  let key = '';
  for (let i = 0; i < 49; i++) key += String(randomInt(10));
  return key;
}

export interface Scenario {
  tenant: string;
  taxpayer: string;
  point: string;
  customer: string;
  user: string;
}

/** BillingSchemaIT.Scenario.create. */
export async function newScenario(db: pg.Client): Promise<Scenario> {
  const tenant = await newTenant(db);
  const taxpayer = await newTaxpayer(db, tenant);
  const establishment = await newEstablishment(db, tenant, taxpayer, '001');
  return {
    tenant,
    taxpayer,
    point: await newEmissionPoint(db, tenant, establishment, '001'),
    customer: await newCustomer(db, tenant, '05', '1712345678'),
    user: await newUser(db),
  };
}

export interface DocumentOptions {
  type?: string;
  /** Nulo para la guía de remisión; el subtotal, el descuento y el IVA quedan en cero. */
  total?: BigDecimal | null;
  content?: string | null;
  accessKey?: string;
  state?: string;
}

/** TestData.document: un comprobante de cualquier tipo por SQL. Devuelve su id. */
export function insertDocument(
  db: pg.Client,
  s: Scenario,
  sequence: number,
  options: DocumentOptions = {},
): Promise<string> {
  const total =
    options.total === undefined ? '1' : (options.total?.toString() ?? null);
  const zero = total === null ? null : '0';
  return id(
    db,
    `INSERT INTO fiscal_documents (tenant_id, taxpayer_id, emission_point_id, customer_id, document_type,
      environment, issuer_ruc, establishment_code, emission_point_code, sequence, access_key, state,
      issue_date, currency, customer_id_type, customer_id_number, customer_name, subtotal, total_discount,
      total_tax, total, created_by, issuer_legal_name, issuer_head_office_address, establishment_address,
      issuer_accounting_required, issuer_rimpe_regime, content)
     VALUES ($1, $2, $3, $4, $5, '1', '1790012345001', '001', '001', $6, $7, $8, DATE '2026-10-10',
      'USD', '05', '1712345678', 'Cliente de prueba', $9, $9, $9, $10, $11, 'Emisor de prueba', 'Quito',
      'Quito', false, 'NONE', CAST($12 AS jsonb))
     RETURNING id`,
    [
      s.tenant,
      s.taxpayer,
      s.point,
      s.customer,
      options.type ?? '01',
      sequence,
      options.accessKey ?? randomAccessKey(),
      options.state ?? 'RESERVED',
      zero,
      total,
      s.user,
      options.content ?? null,
    ],
  );
}

/** Rechazo por una restricción de la base: el código SQLSTATE empieza por 23. */
export async function expectConstraintViolation(
  promise: Promise<unknown>,
): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !code.startsWith('23')) {
    throw new Error(
      `Se esperaba una violación de restricción y fue: ${String(error)}`,
    );
  }
}
