import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { BillingModule } from '../billing/billing.module.js';
import { DocumentKinds } from '../billing/document-kind.js';
import { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import { OutboxWriter } from '../billing/outbox-writer.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { OrchestrationModule } from '../orchestration/orchestration.module.js';
import { WEBHOOK_RECORDER, type WebhookRecorder } from '../orchestration/webhook-recorder.js';
import { ArtifactStore } from '../storage/artifact-store.js';
import { StorageModule } from '../storage/storage.module.js';
import type { DeliveryMailer } from './delivery-mailer.js';
import { DeliveryRepository } from './delivery.repository.js';
import { DELIVERY_MAILER, DeliveryService } from './delivery.service.js';
import { DocumentArchiver } from './document-archiver.js';
import { DueDeliveryScheduler } from './due-delivery-scheduler.js';
import { SmtpDeliveryMailer } from './smtp-delivery-mailer.js';

/**
 * Archivo y entrega de los comprobantes autorizados. Existe también sin worker, como los @Service de Java: lo que
 * lo pone en marcha (el consumidor y el latido) está en WorkerModule.
 */
@Module({
  imports: [DatabaseModule, BillingModule, StorageModule, OrchestrationModule],
  providers: [
    { provide: DeliveryRepository, useFactory: () => new DeliveryRepository() },
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
    {
      provide: DueDeliveryScheduler,
      useFactory: (db: Kysely<DB>, outbox: OutboxWriter) => new DueDeliveryScheduler(db, outbox),
      inject: [DATABASE, OutboxWriter],
    },
    {
      // Solo existe con el correo habilitado: entonces exige un servidor SMTP para arrancar.
      provide: DELIVERY_MAILER,
      useFactory: (config: AppConfig): DeliveryMailer | null =>
        config.delivery.email.enabled ? new SmtpDeliveryMailer(config.mail) : null,
      inject: [APP_CONFIG],
    },
    {
      provide: DeliveryService,
      useFactory: (
        db: Kysely<DB>,
        archiver: DocumentArchiver,
        documents: FiscalDocumentRepository,
        deliveries: DeliveryRepository,
        artifacts: ArtifactStore,
        config: AppConfig,
        mailer: DeliveryMailer | null,
        webhooks: WebhookRecorder,
        kinds: DocumentKinds,
      ) =>
        new DeliveryService(db, archiver, documents, deliveries, artifacts, config.delivery, mailer, webhooks, kinds),
      inject: [
        DATABASE,
        DocumentArchiver,
        FiscalDocumentRepository,
        DeliveryRepository,
        ArtifactStore,
        APP_CONFIG,
        DELIVERY_MAILER,
        WEBHOOK_RECORDER,
        DocumentKinds,
      ],
    },
  ],
  exports: [DocumentArchiver, DeliveryService, DeliveryRepository, DueDeliveryScheduler],
})
export class DeliveryModule {}
