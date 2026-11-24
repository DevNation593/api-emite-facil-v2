import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { BillingModule } from '../billing/billing.module.js';
import { DocumentKinds } from '../billing/document-kind.js';
import { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { ArtifactStore } from '../storage/artifact-store.js';
import { StorageModule } from '../storage/storage.module.js';
import { DocumentArchiver } from './document-archiver.js';

/** Archivo y entrega de los comprobantes autorizados. Existe también sin worker, como los @Service de Java. */
@Module({
  imports: [DatabaseModule, BillingModule, StorageModule],
  providers: [
    {
      provide: DocumentArchiver,
      useFactory: (
        db: Kysely<DB>,
        documents: FiscalDocumentRepository,
        artifacts: ArtifactStore,
        kinds: DocumentKinds,
      ) => new DocumentArchiver(db, documents, artifacts, kinds),
      inject: [DATABASE, FiscalDocumentRepository, ArtifactStore, DocumentKinds],
    },
  ],
  exports: [DocumentArchiver],
})
export class DeliveryModule {}
