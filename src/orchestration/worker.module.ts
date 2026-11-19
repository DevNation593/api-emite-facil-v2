import { type DynamicModule, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { BillingModule } from '../billing/billing.module.js';
import { DocumentKinds } from '../billing/document-kind.js';
import { DocumentXmlCheck } from '../billing/document-xml-check.js';
import { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import { CertificateModule } from '../certificate/certificate.module.js';
import { CertificateService } from '../certificate/certificate.service.js';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { AUTH_PURGE_INTERVAL_MS, AuthPurge } from '../identity/auth-purge.js';
import { SignatureModule } from '../signature/signature.module.js';
import { XadesBesSigner } from '../signature/xades-signer.js';
import { XadesVerifier } from '../signature/xades-verifier.js';
import { ArtifactStore } from '../storage/artifact-store.js';
import { StorageModule } from '../storage/storage.module.js';
import { DocumentProcessor } from './document-processor.js';
import { FixedDelayScheduler } from './fixed-delay-scheduler.js';

/**
 * El trabajo en segundo plano de la instancia (EINVOICE_WORKER_ENABLED, por defecto true). Con
 * false la instancia solo atiende la API y sus tareas no existen, como los
 * `@ConditionalOnProperty(einvoice.worker.enabled)` de Java. Es el punto donde E4–E6 añadirán
 * consumidores y tareas.
 */
@Module({})
export class WorkerModule {
  static register(workerEnabled: boolean): DynamicModule {
    if (!workerEnabled) return { module: WorkerModule };
    return {
      module: WorkerModule,
      imports: [DatabaseModule, BillingModule, CertificateModule, SignatureModule, StorageModule],
      providers: [
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
        { provide: AuthPurge, useFactory: (db: Kysely<DB>) => new AuthPurge(db), inject: [DATABASE] },
        {
          provide: FixedDelayScheduler,
          useFactory: (authPurge: AuthPurge) =>
            new FixedDelayScheduler([
              {
                name: 'auth-purge',
                intervalMs: AUTH_PURGE_INTERVAL_MS,
                run: () => authPurge.purge(),
              },
            ]),
          inject: [AuthPurge],
        },
      ],
    };
  }
}
