import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { BillingModule } from '../billing/billing.module.js';
import { DocumentKinds } from '../billing/document-kind.js';
import { DocumentXmlCheck } from '../billing/document-xml-check.js';
import { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import { OutboxWriter } from '../billing/outbox-writer.js';
import { CertificateModule } from '../certificate/certificate.module.js';
import { CertificateService } from '../certificate/certificate.service.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { RabbitConnection, RabbitModule } from '../infrastructure/rabbit.module.js';
import { SignatureModule } from '../signature/signature.module.js';
import { XadesBesSigner } from '../signature/xades-signer.js';
import { XadesVerifier } from '../signature/xades-verifier.js';
import { SRI_GATEWAY, type SriGateway } from '../sri/http-sri-gateway.js';
import { SriAttemptLog } from '../sri/sri-attempt-log.js';
import { SriModule } from '../sri/sri.module.js';
import { ArtifactStore } from '../storage/artifact-store.js';
import { StorageModule } from '../storage/storage.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { DocumentPipeline } from './document-pipeline.js';
import { DocumentRetryController } from './document-retry.controller.js';
import { DocumentProcessor } from './document-processor.js';
import { DueDocumentScheduler } from './due-document-scheduler.js';
import { OutboxRelay } from './outbox-relay.js';
import { NoWebhooks, WEBHOOK_RECORDER, type WebhookRecorder } from './webhook-recorder.js';

/**
 * Avance de los comprobantes: generación y firma, pipeline ante el SRI, relay del outbox, atrasados y el
 * reintento manual (POST /documents/{id}/retry, que también atiende una instancia sin worker). Existe
 * también sin worker, como los @Service de Java: lo que lo pone en marcha (el consumidor y el latido) está en
 * WorkerModule, que solo se carga en modo worker.
 */
@Module({
  imports: [
    DatabaseModule,
    BillingModule,
    CertificateModule,
    SignatureModule,
    StorageModule,
    SriModule,
    RabbitModule,
    TenancyModule,
    ComplianceModule,
  ],
  controllers: [DocumentRetryController],
  providers: [
    // Los webhooks llegan en E6; hasta entonces el pipeline avisa a un registro que no hace nada.
    { provide: WEBHOOK_RECORDER, useFactory: () => new NoWebhooks() },
    {
      provide: DocumentProcessor,
      useFactory: (
        db: Kysely<DB>,
        documents: FiscalDocumentRepository,
        kinds: DocumentKinds,
        xmlCheck: DocumentXmlCheck,
        certificates: CertificateService,
        signer: XadesBesSigner,
        verifier: XadesVerifier,
        artifacts: ArtifactStore,
      ) => new DocumentProcessor(db, documents, kinds, xmlCheck, certificates, signer, verifier, artifacts),
      inject: [
        DATABASE,
        FiscalDocumentRepository,
        DocumentKinds,
        DocumentXmlCheck,
        CertificateService,
        XadesBesSigner,
        XadesVerifier,
        ArtifactStore,
      ],
    },
    {
      provide: DocumentPipeline,
      useFactory: (
        db: Kysely<DB>,
        documents: FiscalDocumentRepository,
        processor: DocumentProcessor,
        sri: SriGateway,
        config: AppConfig,
        attempts: SriAttemptLog,
        artifacts: ArtifactStore,
        outbox: OutboxWriter,
        webhooks: WebhookRecorder,
      ) => new DocumentPipeline(db, documents, processor, sri, config.sri, attempts, artifacts, outbox, webhooks),
      inject: [
        DATABASE,
        FiscalDocumentRepository,
        DocumentProcessor,
        SRI_GATEWAY,
        APP_CONFIG,
        SriAttemptLog,
        ArtifactStore,
        OutboxWriter,
        WEBHOOK_RECORDER,
      ],
    },
    {
      provide: OutboxRelay,
      useFactory: (db: Kysely<DB>, rabbit: RabbitConnection) => new OutboxRelay(db, rabbit),
      inject: [DATABASE, RabbitConnection],
    },
    {
      provide: DueDocumentScheduler,
      useFactory: (db: Kysely<DB>, outbox: OutboxWriter) => new DueDocumentScheduler(db, outbox),
      inject: [DATABASE, OutboxWriter],
    },
  ],
  exports: [DocumentProcessor, DocumentPipeline, OutboxRelay, DueDocumentScheduler, WEBHOOK_RECORDER],
})
export class OrchestrationModule {}
