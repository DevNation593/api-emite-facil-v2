import type { Kysely } from 'kysely';
import type { DocumentKinds } from '../billing/document-kind.js';
import type { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import { ApiException } from '../common/api-exception.js';
import type { DB } from '../database/schema.js';
import { sriEnvironmentOf } from '../sri/sri-environment.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import { buildAuthorizedXml } from './authorized-xml.js';

const AUTHORIZED = 'AUTHORIZED';

/**
 * Archiva un comprobante autorizado, como delivery/DocumentArchiver.java: guarda como artefactos el XML autorizado
 * que se entrega al receptor y el RIDE en PDF. Se puede llamar las veces que haga falta; cada artefacto se crea una
 * sola vez y después no cambia.
 */
export class DocumentArchiver {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly documents: FiscalDocumentRepository,
    private readonly artifacts: ArtifactStore,
    private readonly kinds: DocumentKinds,
  ) {}

  /** Devuelve false, sin hacer nada, si el comprobante no está autorizado. */
  archive(tenantId: string, documentId: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      // El bloqueo ordena dos archivados simultáneos: el segundo encuentra los artefactos ya creados. Todo va por
      // la misma conexión: pedir otra con el comprobante bloqueado podría agotar el pool.
      const locked = await this.documents.lockForProcessing(trx, tenantId, documentId);
      if (locked === null) throw ApiException.notFound();
      if (locked.state !== AUTHORIZED) return false;
      const ride = await this.documents.rideEnvelope(trx, tenantId, documentId);
      if (ride === null) throw new Error(`Comprobante autorizado sin datos de autorización: ${documentId}`);
      if (!(await this.artifacts.exists(trx, tenantId, documentId, 'XML_AUTHORIZED'))) {
        const signed = await this.artifacts.find(trx, tenantId, documentId, 'XML_SIGNED');
        if (signed === null) throw new Error(`Comprobante autorizado sin su XML firmado: ${documentId}`);
        const xml = buildAuthorizedXml(
          ride.authorizationNumber,
          ride.authorizedAt,
          sriEnvironmentOf(locked.environment),
          signed.content,
        );
        await this.artifacts.save(trx, tenantId, documentId, 'XML_AUTHORIZED', xml);
      }
      if (!(await this.artifacts.exists(trx, tenantId, documentId, 'RIDE_PDF'))) {
        const kind = this.kinds.find(ride.envelope.type.code);
        if (kind === null) throw new Error(`Comprobante autorizado de un tipo sin implementación: ${documentId}`);
        const content = await kind.loadContent(trx, tenantId, documentId);
        await this.artifacts.save(trx, tenantId, documentId, 'RIDE_PDF', await kind.buildRide(trx, ride, content));
      }
      // Archivado: ya no hace falta la red de seguridad que lo mantenía programado.
      await this.documents.schedule(trx, tenantId, documentId, null, 0);
      return true;
    });
  }
}
