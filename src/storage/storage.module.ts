import { Module } from '@nestjs/common';
import { ArtifactStore } from './artifact-store.js';

/** Artefactos inmutables de los comprobantes. La descarga llega en E5. */
@Module({
  providers: [{ provide: ArtifactStore, useFactory: () => new ArtifactStore() }],
  exports: [ArtifactStore],
})
export class StorageModule {}
