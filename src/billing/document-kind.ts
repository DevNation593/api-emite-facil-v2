import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../database/schema.js';
import type { DocumentSchema, DocumentType } from '../xml/document-type.js';
import type { DocumentEnvelope } from './document-envelope.js';

/**
 * Un tipo de comprobante como pieza: qué esquema emite, cómo se llama, cómo guarda y lee su contenido
 * propio y cómo genera su XML a partir del sobre común (billing/DocumentKind.java; el RIDE llega en
 * E5). Hay una implementación por tipo habilitado; `DocumentKinds` las reúne. Los métodos se declaran
 * con sintaxis de método para que un `DocumentKind<InvoiceBody>` sirva donde se pide `DocumentKind<unknown>`.
 */
export interface DocumentKind<C> {
  /** Código del comprobante: 01, 03, 04, 05, 06 o 07. */
  readonly type: DocumentType;
  /** Versión del XSD con que se emite. */
  readonly schema: DocumentSchema;
  /** Nombre para el correo, el PDF y la descarga: «Factura», «Nota de crédito»… */
  readonly displayName: string;
  /** Raíz del nombre de los archivos: «factura», «nota-credito»… */
  readonly fileStem: string;
  /** Acción de auditoría al reservar el comprobante: INVOICE_RESERVED, CREDIT_NOTE_RESERVED… */
  readonly auditReserved: string;

  /** JSON para la columna content, que va en el mismo INSERT del sobre; nulo para la factura. */
  contentJson(content: C): string | null;

  /**
   * El contenido tal como el worker lo leerá después de guardarlo. Los tipos que guardan JSON lo pasan
   * por su ida y vuelta; la factura, que no usa JSON, lo devuelve igual.
   */
  reloaded(content: C): C;

  /** Lo que el tipo guarda en tablas propias tras insertar el sobre; la factura, su cuerpo. */
  saveDetails(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
    content: C,
  ): Promise<void>;

  /** Contenido propio del comprobante ya guardado. */
  loadContent(
    db: Kysely<DB> | Transaction<DB>,
    tenantId: string,
    documentId: string,
  ): Promise<C>;

  /** XML sin firmar del comprobante. */
  buildXml(envelope: DocumentEnvelope, content: C): Buffer;
}

/** Las piezas de cada tipo de comprobante habilitado, por tipo. Dos piezas para el mismo tipo no arrancan. */
export class DocumentKinds {
  private readonly byCode = new Map<string, DocumentKind<unknown>>();

  register<C>(kind: DocumentKind<C>): void {
    if (this.byCode.has(kind.type.code)) {
      throw new Error(
        `Hay dos implementaciones para el tipo de comprobante ${kind.type.name}`,
      );
    }
    this.byCode.set(kind.type.code, kind as DocumentKind<unknown>);
  }

  find(code: string): DocumentKind<unknown> | null {
    return this.byCode.get(code) ?? null;
  }
}
