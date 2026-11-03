import type { FiscalDocumentRepository } from '../../../src/billing/fiscal-document.repository.js';
import { DocumentKinds } from '../../../src/billing/document-kind.js';
import { InvoiceKind } from '../../../src/billing/invoice-kind.js';
import { buildCreditNoteXml } from '../../../src/notes/credit-note-content.js';
import { CreditNoteKind } from '../../../src/notes/credit-note-kind.js';
import { buildDebitNoteXml } from '../../../src/notes/debit-note-content.js';
import { DebitNoteKind } from '../../../src/notes/debit-note-kind.js';
import {
  DOCUMENT_SCHEMAS,
  DOCUMENT_TYPES,
} from '../../../src/xml/document-type.js';
import {
  creditContent,
  creditEnvelope,
  debitContent,
  debitEnvelope,
} from './note-fixtures.js';

// Traducción de NoteKindsTest (sin el RIDE, que llega en E5).
const noRepository = null as unknown as FiscalDocumentRepository;
const credit = new CreditNoteKind(noRepository);
const debit = new DebitNoteKind(noRepository);

describe('tipos de nota', () => {
  it('el registro encuentra las dos notas', () => {
    const kinds = new DocumentKinds();
    kinds.register(new InvoiceKind(noRepository));
    kinds.register(credit);
    kinds.register(debit);
    expect(kinds.find(DOCUMENT_TYPES.CREDIT_NOTE.code)).toBe(credit);
    expect(kinds.find(DOCUMENT_TYPES.DEBIT_NOTE.code)).toBe(debit);
  });

  it('identidad de la nota de crédito', () => {
    expect(credit.type).toBe(DOCUMENT_TYPES.CREDIT_NOTE);
    expect(credit.schema).toBe(DOCUMENT_SCHEMAS.CREDIT_NOTE_1_1_0);
    expect(credit.displayName).toBe('Nota de crédito');
    expect(credit.fileStem).toBe('nota-credito');
    expect(credit.auditReserved).toBe('CREDIT_NOTE_RESERVED');
  });

  it('identidad de la nota de débito', () => {
    expect(debit.type).toBe(DOCUMENT_TYPES.DEBIT_NOTE);
    expect(debit.schema).toBe(DOCUMENT_SCHEMAS.DEBIT_NOTE_1_0_0);
    expect(debit.displayName).toBe('Nota de débito');
    expect(debit.fileStem).toBe('nota-debito');
    expect(debit.auditReserved).toBe('DEBIT_NOTE_RESERVED');
  });

  it('el XML es el de los generadores', () => {
    expect(
      credit
        .buildXml(creditEnvelope(), creditContent())
        .equals(buildCreditNoteXml(creditEnvelope(), creditContent())),
    ).toBe(true);
    expect(
      debit
        .buildXml(debitEnvelope(null), debitContent('Mora'))
        .equals(buildDebitNoteXml(debitEnvelope(null), debitContent('Mora'))),
    ).toBe(true);
  });

  it('el contenido sobrevive a la ida y vuelta por JSON', () => {
    expect(credit.reloaded(creditContent())).toEqual(creditContent());
    expect(debit.reloaded(debitContent('Mora'))).toEqual(debitContent('Mora'));
  });
});
