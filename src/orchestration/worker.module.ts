import { type DynamicModule, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { DeliveryModule } from '../delivery/delivery.module.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import { DeliveryWorker } from '../delivery/delivery-worker.js';
import { DueDeliveryScheduler } from '../delivery/due-delivery-scheduler.js';
import { AUTH_PURGE_INTERVAL_MS, AuthPurge } from '../identity/auth-purge.js';
import { RabbitConnection, RabbitModule } from '../infrastructure/rabbit.module.js';
import { DocumentPipeline } from './document-pipeline.js';
import { DocumentWorker } from './document-worker.js';
import { DueDocumentScheduler } from './due-document-scheduler.js';
import { FixedDelayScheduler } from './fixed-delay-scheduler.js';
import { OrchestrationModule } from './orchestration.module.js';
import { OutboxRelay } from './outbox-relay.js';
import { WORKER_TICK, WorkerSchedule } from './worker-schedule.js';

/**
 * El trabajo en segundo plano de la instancia (EINVOICE_WORKER_ENABLED, por defecto true). Con
 * false la instancia solo atiende la API y sus tareas no existen, como los
 * `@ConditionalOnProperty(einvoice.worker.enabled)` de Java: los consumidores de comprobantes y de
 * entregas, el latido que encola los vencidos y publica el outbox, y la purga de la cuenta. E6 añadirá los avisos.
 */
@Module({})
export class WorkerModule {
  static register(workerEnabled: boolean): DynamicModule {
    if (!workerEnabled) return { module: WorkerModule };
    return {
      module: WorkerModule,
      imports: [DatabaseModule, RabbitModule, OrchestrationModule, DeliveryModule],
      providers: [
        { provide: AuthPurge, useFactory: (db: Kysely<DB>) => new AuthPurge(db), inject: [DATABASE] },
        {
          provide: WorkerSchedule,
          useFactory: (due: DueDocumentScheduler, dueDeliveries: DueDeliveryScheduler, relay: OutboxRelay) =>
            new WorkerSchedule(due, dueDeliveries, relay),
          inject: [DueDocumentScheduler, DueDeliveryScheduler, OutboxRelay],
        },
        {
          provide: DocumentWorker,
          useFactory: (rabbit: RabbitConnection, pipeline: DocumentPipeline, config: AppConfig) =>
            new DocumentWorker(rabbit, pipeline, config.worker.maxConsumers),
          inject: [RabbitConnection, DocumentPipeline, APP_CONFIG],
        },
        {
          provide: DeliveryWorker,
          useFactory: (rabbit: RabbitConnection, deliveries: DeliveryService, config: AppConfig) =>
            new DeliveryWorker(rabbit, deliveries, config.worker.maxConsumers),
          inject: [RabbitConnection, DeliveryService, APP_CONFIG],
        },
        {
          provide: FixedDelayScheduler,
          useFactory: (authPurge: AuthPurge, schedule: WorkerSchedule, config: AppConfig) =>
            new FixedDelayScheduler([
              {
                name: 'auth-purge',
                intervalMs: AUTH_PURGE_INTERVAL_MS,
                run: () => authPurge.purge(),
              },
              {
                // Encola los vencidos y publica el outbox; un fallo se registra y espera al siguiente latido.
                name: WORKER_TICK,
                intervalMs: config.worker.pollIntervalMs,
                run: () => schedule.tick(),
              },
            ]),
          inject: [AuthPurge, WorkerSchedule, APP_CONFIG],
        },
      ],
    };
  }
}
