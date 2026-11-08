import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CatalogRepository } from '../catalog/catalog.repository.js';
import { CustomerService } from '../catalog/customer.service.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CatalogLines } from '../billing/catalog-lines.js';
import { DocumentIssuer } from '../billing/document-issuer.js';
import { DocumentKinds } from '../billing/document-kind.js';
import { FinalConsumerLimit } from '../billing/final-consumer-limit.js';
import { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import { CreditNoteController } from './credit-note.controller.js';
import { CreditNoteKind } from './credit-note-kind.js';
import { CreditNoteService } from './credit-note.service.js';
import { DebitNoteController } from './debit-note.controller.js';
import { DebitNoteKind } from './debit-note-kind.js';
import { DebitNoteService } from './debit-note.service.js';
import { ModifiedInvoices } from './modified-invoices.js';

/**
 * Notas de crédito y débito sobre lo común de BillingModule. Al iniciar registra sus tipos en
 * DocumentKinds, de donde los leen la consulta de comprobantes y, en E4, el worker.
 */
@Module({
  imports: [BillingModule, CatalogModule, TenancyModule],
  controllers: [CreditNoteController, DebitNoteController],
  providers: [
    {
      provide: CreditNoteKind,
      useFactory: (documents: FiscalDocumentRepository) => new CreditNoteKind(documents),
      inject: [FiscalDocumentRepository],
    },
    {
      provide: DebitNoteKind,
      useFactory: (documents: FiscalDocumentRepository) => new DebitNoteKind(documents),
      inject: [FiscalDocumentRepository],
    },
    {
      provide: ModifiedInvoices,
      useFactory: (documents: FiscalDocumentRepository) => new ModifiedInvoices(documents),
      inject: [FiscalDocumentRepository],
    },
    {
      provide: CreditNoteService,
      useFactory: (
        issuer: DocumentIssuer,
        kind: CreditNoteKind,
        invoices: ModifiedInvoices,
        documents: FiscalDocumentRepository,
        customers: CustomerService,
        catalogLines: CatalogLines,
      ) => new CreditNoteService(issuer, kind, invoices, documents, customers, catalogLines),
      inject: [DocumentIssuer, CreditNoteKind, ModifiedInvoices, FiscalDocumentRepository, CustomerService, CatalogLines],
    },
    {
      provide: DebitNoteService,
      useFactory: (
        issuer: DocumentIssuer,
        kind: DebitNoteKind,
        invoices: ModifiedInvoices,
        customers: CustomerService,
        catalogLines: CatalogLines,
        catalogs: CatalogRepository,
        finalConsumerLimit: FinalConsumerLimit,
      ) => new DebitNoteService(issuer, kind, invoices, customers, catalogLines, catalogs, finalConsumerLimit),
      inject: [
        DocumentIssuer,
        DebitNoteKind,
        ModifiedInvoices,
        CustomerService,
        CatalogLines,
        CatalogRepository,
        FinalConsumerLimit,
      ],
    },
  ],
})
export class NotesModule implements OnModuleInit {
  constructor(
    @Inject(DocumentKinds) private readonly kinds: DocumentKinds,
    @Inject(CreditNoteKind) private readonly creditNote: CreditNoteKind,
    @Inject(DebitNoteKind) private readonly debitNote: DebitNoteKind,
  ) {}

  onModuleInit(): void {
    this.kinds.register(this.creditNote);
    this.kinds.register(this.debitNote);
  }
}
