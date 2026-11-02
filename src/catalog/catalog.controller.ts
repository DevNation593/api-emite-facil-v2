import { Controller, Get, Inject } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { formatDecimal } from '../common/decimals.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { CatalogRepository, type CodeName, type PaymentMethod } from './catalog.repository.js';

interface TaxRateResponse {
  taxCode: string;
  rateCode: string;
  description: string;
  rate: string;
}

/**
 * Catálogos de solo lectura para cualquier identidad autenticada (persona o API key); no dependen
 * de la empresa, así que no llevan TenantAccessGuard.
 */
@Controller('catalogs')
export class CatalogController {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly catalogs: CatalogRepository,
  ) {}

  @Get('identification-types')
  identificationTypes(): Promise<CodeName[]> {
    return this.catalogs.identificationTypes(this.db);
  }

  @Get('payment-methods')
  paymentMethods(): Promise<PaymentMethod[]> {
    return this.catalogs.paymentMethods(this.db);
  }

  @Get('tax-rates')
  async taxRates(): Promise<TaxRateResponse[]> {
    return (await this.catalogs.taxRates(this.db)).map((rate) => ({
      taxCode: rate.taxCode,
      rateCode: rate.rateCode,
      description: rate.description,
      rate: formatDecimal(rate.rate, 2),
    }));
  }
}
