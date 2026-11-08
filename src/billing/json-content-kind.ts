import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../database/schema.js';
import type { DocumentSchema, DocumentType } from '../xml/document-type.js';
import type { DocumentEnvelope } from './document-envelope.js';
import type { DocumentKind } from './document-kind.js';
import type { FiscalDocumentRepository } from './fiscal-document.repository.js';
import type { ContentCodec } from './json-content.js';

/**
 * Base de los tipos cuyo contenido propio viaja como JSON en la columna content del sobre
 * (billing/JsonContentKind.java). El códec fija el formato: todo decimal, también el anidado, se
 * escribe como cadena JSON para que vuelva con la misma escala, y una propiedad desconocida falla al
 * leer, de modo que un campo renombrado no se carga como nulo en silencio.
 */
export abstract class JsonContentKind<C> implements DocumentKind<C> {
  abstract readonly type: DocumentType;
  abstract readonly schema: DocumentSchema;
  abstract readonly displayName: string;
  abstract readonly fileStem: string;
  abstract readonly auditReserved: string;

  protected constructor(
    private readonly codec: ContentCodec<C>,
    private readonly documents: FiscalDocumentRepository,
  ) {}

  abstract buildXml(envelope: DocumentEnvelope, content: C): Buffer;

  contentJson(content: C): string | null {
    return this.codec.write(content);
  }

  reloaded(content: C): C {
    return this.codec.read(this.codec.write(content));
  }

  /** Los tipos con JSON no tienen tablas propias. */
  saveDetails(): Promise<void> {
    return Promise.resolve();
  }

  async loadContent(
    db: Kysely<DB> | Transaction<DB>,
    tenantId: string,
    documentId: string,
  ): Promise<C> {
    const content = await this.documents.content(db, tenantId, documentId);
    if (content === null) {
      throw new Error(
        `El comprobante ${documentId} no existe o no tiene contenido propio`,
      );
    }
    return this.codec.read(content);
  }
}
