import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CatalogRepository } from '../catalog/catalog.repository.js';
import { CustomerService } from '../catalog/customer.service.js';
import { ProductService } from '../catalog/product.service.js';
import { AuditLog } from '../compliance/audit-log.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { SequenceModule } from '../sequence/sequence.module.js';
import { SequenceService } from '../sequence/sequence.service.js';
import { TaxpayerModule } from '../taxpayer/taxpayer.module.js';
import { TaxpayerService } from '../taxpayer/taxpayer.service.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { XmlModule } from '../xml/xml.module.js';
import { XsdValidator } from '../xml/xsd-validator.js';
import { CatalogLines } from './catalog-lines.js';
import { DocumentController } from './document.controller.js';
import { DocumentIssuer } from './document-issuer.js';
import { DocumentKinds } from './document-kind.js';
import { DocumentXmlCheck } from './document-xml-check.js';
import { FinalConsumerLimit } from './final-consumer-limit.js';
import { FiscalDocumentRepository } from './fiscal-document.repository.js';
import { IdempotencyStore } from './idempotency-store.js';
import { InvoiceKind } from './invoice-kind.js';
import { InvoiceController } from './invoice.controller.js';
import { InvoiceService } from './invoice.service.js';
import { OutboxWriter } from './outbox-writer.js';

/** Emisión de facturas y lo común a todo comprobante; las notas (NotesModule) reutilizan lo exportado. */
@Module({
  imports: [TenancyModule, ComplianceModule, CatalogModule, TaxpayerModule, SequenceModule, XmlModule],
  controllers: [InvoiceController, DocumentController],
  providers: [
    { provide: FiscalDocumentRepository, useFactory: () => new FiscalDocumentRepository() },
    { provide: IdempotencyStore, useFactory: () => new IdempotencyStore() },
    { provide: OutboxWriter, useFactory: () => new OutboxWriter() },
    {
      provide: DocumentXmlCheck,
      useFactory: (validator: XsdValidator) => new DocumentXmlCheck(validator),
      inject: [XsdValidator],
    },
    {
      provide: InvoiceKind,
      useFactory: (documents: FiscalDocumentRepository) => new InvoiceKind(documents),
      inject: [FiscalDocumentRepository],
    },
    {
      provide: DocumentKinds,
      useFactory: (invoice: InvoiceKind) => {
        const kinds = new DocumentKinds();
        kinds.register(invoice);
        return kinds;
      },
      inject: [InvoiceKind],
    },
    {
      provide: CatalogLines,
      useFactory: (products: ProductService, catalogs: CatalogRepository) => new CatalogLines(products, catalogs),
      inject: [ProductService, CatalogRepository],
    },
    {
      provide: FinalConsumerLimit,
      useFactory: (catalogs: CatalogRepository) => new FinalConsumerLimit(catalogs),
      inject: [CatalogRepository],
    },
    {
      provide: DocumentIssuer,
      useFactory: (
        db: Kysely<DB>,
        taxpayers: TaxpayerService,
        sequences: SequenceService,
        documents: FiscalDocumentRepository,
        xmlCheck: DocumentXmlCheck,
        outbox: OutboxWriter,
        audit: AuditLog,
        idempotency: IdempotencyStore,
        config: AppConfig,
      ) =>
        new DocumentIssuer(
          db,
          taxpayers,
          sequences,
          documents,
          xmlCheck,
          outbox,
          audit,
          idempotency,
          config.providerRuc,
        ),
      inject: [
        DATABASE,
        TaxpayerService,
        SequenceService,
        FiscalDocumentRepository,
        DocumentXmlCheck,
        OutboxWriter,
        AuditLog,
        IdempotencyStore,
        APP_CONFIG,
      ],
    },
    {
      provide: InvoiceService,
      useFactory: (
        issuer: DocumentIssuer,
        kind: InvoiceKind,
        customers: CustomerService,
        catalogLines: CatalogLines,
        catalogs: CatalogRepository,
        finalConsumerLimit: FinalConsumerLimit,
      ) => new InvoiceService(issuer, kind, customers, catalogLines, catalogs, finalConsumerLimit),
      inject: [DocumentIssuer, InvoiceKind, CustomerService, CatalogLines, CatalogRepository, FinalConsumerLimit],
    },
  ],
  exports: [
    FiscalDocumentRepository,
    DocumentIssuer,
    DocumentKinds,
    CatalogLines,
    FinalConsumerLimit,
    IdempotencyStore,
    OutboxWriter,
    DocumentXmlCheck,
  ],
})
export class BillingModule {}
