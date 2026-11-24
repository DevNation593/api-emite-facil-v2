import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { ArtifactController } from './artifact.controller.js';
import { ArtifactStore } from './artifact-store.js';

/** Artefactos inmutables de los comprobantes y su descarga. */
@Module({
  imports: [DatabaseModule, BillingModule, TenancyModule],
  controllers: [ArtifactController],
  providers: [{ provide: ArtifactStore, useFactory: () => new ArtifactStore() }],
  exports: [ArtifactStore],
})
export class StorageModule {}
