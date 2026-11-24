import { createHash } from 'node:crypto';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { DB } from '../database/schema.js';
import type { ArtifactKind } from './artifact-kind.js';

/*
 * Artefactos inmutables de un comprobante, con su SHA-256, como storage/ArtifactStore.java. Se insertan una
 * vez y no se actualizan (la base lo impone con disparadores). El contenido vive en PostgreSQL mientras no se
 * decida el almacenamiento de objetos (docs/13-deployment.md); los servicios solo dependen de esta clase.
 */

type Db = Kysely<DB> | Transaction<DB>;

export interface StoredArtifact {
  content: Buffer;
  sha256: string;
}

/** Artefacto con el número del comprobante al que pertenece, para nombrar la descarga. */
export interface ArtifactDownload extends StoredArtifact {
  documentType: string;
  number: string;
}

export function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export class ArtifactStore {
  /** Guarda el artefacto y devuelve su SHA-256. Falla si el documento ya tiene uno de ese tipo. */
  async save(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
    kind: ArtifactKind,
    content: Buffer,
  ): Promise<string> {
    // Propagation.MANDATORY en Java: el artefacto se guarda con el cambio de estado que lo produce.
    if (!trx.isTransaction) throw new Error('El artefacto se guarda dentro de una transacción abierta');
    const sha256 = sha256Hex(content);
    await sql`
      INSERT INTO document_artifacts (tenant_id, document_id, kind, sha256, content)
      VALUES (${tenantId}, ${documentId}, ${kind}, ${sha256}, ${content})`.execute(trx);
    return sha256;
  }

  async find(db: Db, tenantId: string, documentId: string, kind: ArtifactKind): Promise<StoredArtifact | null> {
    const result = await sql<{ content: Buffer; sha256: string }>`
      SELECT content, sha256 FROM document_artifacts
      WHERE tenant_id = ${tenantId} AND document_id = ${documentId} AND kind = ${kind}`.execute(db);
    const row = result.rows[0];
    return row === undefined ? null : { content: row.content, sha256: row.sha256 };
  }

  async findForDownload(
    db: Db,
    tenantId: string,
    documentId: string,
    kind: ArtifactKind,
  ): Promise<ArtifactDownload | null> {
    const result = await sql<{ content: Buffer; sha256: string; document_type: string; number: string }>`
      SELECT a.content, a.sha256, d.document_type,
             d.establishment_code || '-' || d.emission_point_code || '-' || lpad(d.sequence::text, 9, '0') AS number
        FROM document_artifacts a JOIN fiscal_documents d ON d.tenant_id = a.tenant_id AND d.id = a.document_id
       WHERE a.tenant_id = ${tenantId} AND a.document_id = ${documentId} AND a.kind = ${kind}`.execute(db);
    const row = result.rows[0];
    return row === undefined
      ? null
      : { content: row.content, sha256: row.sha256, documentType: row.document_type, number: row.number };
  }

  async exists(db: Db, tenantId: string, documentId: string, kind: ArtifactKind): Promise<boolean> {
    const result = await sql<{ count: string }>`
      SELECT count(*) AS count FROM document_artifacts
      WHERE tenant_id = ${tenantId} AND document_id = ${documentId} AND kind = ${kind}`.execute(db);
    return Number(result.rows[0]!.count) > 0;
  }
}
