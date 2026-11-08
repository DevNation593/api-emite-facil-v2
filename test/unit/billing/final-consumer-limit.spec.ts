import type { Transaction } from 'kysely';
import { BigDecimal } from '../../../src/common/big-decimal.js';
import type { CatalogRepository } from '../../../src/catalog/catalog.repository.js';
import { FinalConsumerLimit } from '../../../src/billing/final-consumer-limit.js';
import type { DB } from '../../../src/database/schema.js';

const catalogs = {
  identificationType: async (_trx: unknown, code: string) => ({ finalConsumer: code === '07' }),
} as unknown as CatalogRepository;
const trx = {} as Transaction<DB>;

describe('FinalConsumerLimit', () => {
  it('por defecto rechaza más de 50.00 a consumidor final y deja pasar 50.00', async () => {
    const limit = new FinalConsumerLimit(catalogs);
    await limit.check(trx, '07', BigDecimal.of('50.00'));
    await expect(limit.check(trx, '07', BigDecimal.of('50.01'))).rejects.toMatchObject({
      errorCode: 'FINAL_CONSUMER_LIMIT_EXCEEDED',
    });
  });

  it('respeta un límite configurado', async () => {
    const limit = new FinalConsumerLimit(catalogs, BigDecimal.of('200'));
    await limit.check(trx, '07', BigDecimal.of('150.00'));
    await expect(limit.check(trx, '07', BigDecimal.of('200.01'))).rejects.toMatchObject({
      errorCode: 'FINAL_CONSUMER_LIMIT_EXCEEDED',
    });
  });

  it('no limita a un comprador identificado', async () => {
    await new FinalConsumerLimit(catalogs).check(trx, '05', BigDecimal.of('9999.00'));
  });
});
