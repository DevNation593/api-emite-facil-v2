import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditLog } from '../compliance/audit-log.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogRepository } from './catalog.repository.js';
import { CustomerController, ProductController } from './customer.controller.js';
import { CustomerService } from './customer.service.js';
import { ProductService } from './product.service.js';

/** Catálogos del SRI, clientes y productos. */
@Module({
  imports: [TenancyModule, ComplianceModule],
  controllers: [CatalogController, CustomerController, ProductController],
  providers: [
    { provide: CatalogRepository, useFactory: () => new CatalogRepository() },
    {
      provide: CustomerService,
      useFactory: (db: Kysely<DB>, catalogs: CatalogRepository, audit: AuditLog) =>
        new CustomerService(db, catalogs, audit),
      inject: [DATABASE, CatalogRepository, AuditLog],
    },
    {
      provide: ProductService,
      useFactory: (db: Kysely<DB>, catalogs: CatalogRepository, audit: AuditLog) =>
        new ProductService(db, catalogs, audit),
      inject: [DATABASE, CatalogRepository, AuditLog],
    },
  ],
  exports: [CatalogRepository, CustomerService, ProductService],
})
export class CatalogModule {}
