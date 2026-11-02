import { type DynamicModule, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { AUTH_PURGE_INTERVAL_MS, AuthPurge } from '../identity/auth-purge.js';
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
      imports: [DatabaseModule],
      providers: [
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
