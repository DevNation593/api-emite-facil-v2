import type { Transaction } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import { BigDecimal } from '../common/big-decimal.js';
import type { CatalogRepository } from '../catalog/catalog.repository.js';
import { DEFAULT_FINAL_CONSUMER_LIMIT } from '../config/app-config.js';
import type { DB } from '../database/schema.js';

/** Monto máximo de un comprobante a consumidor final: lo comparten la factura y la nota de débito. */
export class FinalConsumerLimit {
  constructor(
    private readonly catalogs: CatalogRepository,
    private readonly limit: BigDecimal = BigDecimal.of(DEFAULT_FINAL_CONSUMER_LIMIT),
  ) {}

  /** 422 FINAL_CONSUMER_LIMIT_EXCEEDED si el comprador es consumidor final y el total supera el límite. */
  async check(trx: Transaction<DB>, identificationType: string, total: BigDecimal): Promise<void> {
    const type = await this.catalogs.identificationType(trx, identificationType);
    if ((type?.finalConsumer ?? false) && total.compareTo(this.limit) > 0) {
      throw new ApiException(
        422,
        'FINAL_CONSUMER_LIMIT_EXCEEDED',
        'Una venta a consumidor final no puede superar el monto máximo; identifique al adquirente',
      );
    }
  }
}
