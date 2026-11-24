import type { Kysely, Transaction } from 'kysely';
import type { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import type { DocumentEnvelope } from '../billing/document-envelope.js';
import { JsonContentKind } from '../billing/json-content-kind.js';
import type { RideEnvelope } from '../billing/ride-envelope.js';
import type { DB } from '../database/schema.js';
import { DOCUMENT_TYPES } from '../xml/document-type.js';
import {
  buildCreditNoteXml,
  CREDIT_NOTE_CODEC,
  CREDIT_NOTE_SCHEMA,
  type CreditNoteContent,
} from './credit-note-content.js';
import { buildCreditNoteRide } from './note-ride.js';

/** La nota de crédito como tipo de comprobante: su contenido viaja como JSON en el sobre. */
export class CreditNoteKind extends JsonContentKind<CreditNoteContent> {
  readonly type = DOCUMENT_TYPES.CREDIT_NOTE;
  readonly schema = CREDIT_NOTE_SCHEMA;
  readonly displayName = 'Nota de crédito';
  readonly fileStem = 'nota-credito';
  readonly auditReserved = 'CREDIT_NOTE_RESERVED';

  constructor(documents: FiscalDocumentRepository) {
    super(CREDIT_NOTE_CODEC, documents);
  }

  buildXml(envelope: DocumentEnvelope, content: CreditNoteContent): Buffer {
    return buildCreditNoteXml(envelope, content);
  }

  buildRide(
    _db: Kysely<DB> | Transaction<DB>,
    ride: RideEnvelope,
    content: CreditNoteContent,
  ): Promise<Buffer> {
    return buildCreditNoteRide(ride, content);
  }
}
