import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogRepository } from './catalog.repository.js';

/** Catálogos del SRI, clientes y productos. */
@Module({
  imports: [DatabaseModule],
  controllers: [CatalogController],
  providers: [{ provide: CatalogRepository, useFactory: () => new CatalogRepository() }],
  exports: [CatalogRepository],
})
export class CatalogModule {}
