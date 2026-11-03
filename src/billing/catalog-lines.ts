import type { Transaction } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { BigDecimal } from '../common/big-decimal.js';
import type { CatalogRepository } from '../catalog/catalog.repository.js';
import type { ProductService, ProductView } from '../catalog/product.service.js';
import type { DB } from '../database/schema.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';
import {
  calculateInvoice,
  InvalidLineError,
  type InvoiceLineInput,
  type InvoiceTotals,
} from './invoice-calculator.js';

/*
 * Reglas de las líneas que comparten la factura y las notas (billing/CatalogLines.java): el producto del
 * catálogo con su tarifa de IVA, y el cálculo de la factura con sus errores (INVALID_LINE,
 * AMOUNT_TOO_LARGE).
 */

/** Mayor importe que cabe en las columnas numeric(14,2) del documento. */
export const MAX_AMOUNT = BigDecimal.of('999999999999.99');

/** Una línea pedida: precio y descuento nulos toman los del producto y cero. */
export interface LineCommand {
  productId: string;
  quantity: BigDecimal;
  unitPrice: BigDecimal | null;
  discount: BigDecimal | null;
}

/** Una línea pedida, con su producto del catálogo y lista para el cálculo. */
export interface CatalogLine {
  product: ProductView;
  input: InvoiceLineInput;
}

const unprocessable = (errorCode: 'TAX_RATE_UNKNOWN' | 'INVALID_LINE' | 'AMOUNT_TOO_LARGE', detail: string) =>
  new ApiException(422, errorCode, detail);

export class CatalogLines {
  constructor(
    private readonly products: ProductService,
    private readonly catalogs: CatalogRepository,
  ) {}

  /**
   * Cada línea con su producto: precio por omisión, el del producto; descuento por omisión, cero; la
   * tarifa de IVA, la del producto. Un producto ajeno o archivado responde 404. Todo por la transacción
   * de la emisión.
   */
  async resolve(trx: Transaction<DB>, access: TenantAccess, lines: LineCommand[]): Promise<CatalogLine[]> {
    const resolved: CatalogLine[] = [];
    for (const line of lines) {
      const product = await this.products.get(access, line.productId, trx);
      const { version: _version, ...view } = product;
      resolved.push({
        product: view,
        input: {
          quantity: line.quantity,
          // La columna numeric(18,6) llega con sus seis decimales, como el BigDecimal de JPA.
          unitPrice: line.unitPrice ?? BigDecimal.of(product.unitPrice),
          discount: line.discount ?? BigDecimal.ZERO,
          ivaRateCode: product.ivaRateCode,
          ivaRate: await this.ivaRate(trx, product.ivaRateCode),
        },
      });
    }
    return resolved;
  }

  /** Porcentaje de una tarifa de IVA del catálogo; 422 TAX_RATE_UNKNOWN si no existe. */
  async ivaRate(trx: Transaction<DB>, rateCode: string): Promise<BigDecimal> {
    const rate = await this.catalogs.ivaRate(trx, rateCode);
    if (rate === null) throw unprocessable('TAX_RATE_UNKNOWN', 'La tarifa de IVA del producto no existe');
    return rate;
  }
}

/**
 * Cálculo de la factura (redondeo por línea y por tarifa) con sus errores: una línea que no se puede
 * calcular responde 422 INVALID_LINE, un importe que no cabe en el documento 422 AMOUNT_TOO_LARGE.
 */
export function calculateStorable(inputs: InvoiceLineInput[]): InvoiceTotals {
  let totals: InvoiceTotals;
  try {
    totals = calculateInvoice(inputs);
  } catch (error) {
    if (error instanceof InvalidLineError) throw unprocessable('INVALID_LINE', error.message);
    throw error;
  }
  requireStorable(totals.subtotal, totals.totalDiscount, totals.total);
  requireStorable(...totals.lines.map((line) => line.subtotal));
  return totals;
}

/** 422 AMOUNT_TOO_LARGE si algún importe no cabe en las columnas del documento. */
export function requireStorable(...amounts: BigDecimal[]): void {
  for (const amount of amounts) {
    if (amount.compareTo(MAX_AMOUNT) > 0) {
      throw unprocessable('AMOUNT_TOO_LARGE', 'Los importes del comprobante superan el máximo admitido');
    }
  }
}
