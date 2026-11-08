import type { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import type { DocumentEnvelope } from '../billing/document-envelope.js';
import { JsonContentKind } from '../billing/json-content-kind.js';
import { DOCUMENT_TYPES } from '../xml/document-type.js';
import {
  buildDebitNoteXml,
  DEBIT_NOTE_CODEC,
  DEBIT_NOTE_SCHEMA,
  type DebitNoteContent,
} from './debit-note-content.js';

/** La nota de débito como tipo de comprobante: su contenido viaja como JSON en el sobre. */
export class DebitNoteKind extends JsonContentKind<DebitNoteContent> {
  readonly type = DOCUMENT_TYPES.DEBIT_NOTE;
  readonly schema = DEBIT_NOTE_SCHEMA;
  readonly displayName = 'Nota de débito';
  readonly fileStem = 'nota-debito';
  readonly auditReserved = 'DEBIT_NOTE_RESERVED';

  constructor(documents: FiscalDocumentRepository) {
    super(DEBIT_NOTE_CODEC, documents);
  }

  buildXml(envelope: DocumentEnvelope, content: DebitNoteContent): Buffer {
    return buildDebitNoteXml(envelope, content);
  }
}
