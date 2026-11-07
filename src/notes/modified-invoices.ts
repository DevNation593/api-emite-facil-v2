import type { Transaction } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import type { BigDecimal } from '../common/big-decimal.js';
import type { ErrorCode } from '../common/error-codes.js';
import { localDateIsAfter } from '../common/java-time.js';
import type { DB } from '../database/schema.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';
import { DOCUMENT_TYPES } from '../xml/document-type.js';
import {
  documentNumber,
  type ModifiedDocument,
  type Recipient,
  requireTotals,
} from '../billing/document-envelope.js';
import type { FiscalDocumentRepository, LineRow } from '../billing/fiscal-document.repository.js';

/*
 * La factura que modifica una nota (notes/ModifiedInvoices.java): la de la plataforma se busca en la
 * empresa, se valida y se bloquea; la escrita a mano solo trae su número y su fecha.
 */

const AUTHORIZED = 'AUTHORIZED';

/**
 * Lo que la nota toma de la factura: su número (EEE-PPP-SSSSSSSSS), su fecha, su total, su comprador (la
 * fila del catálogo y los datos tal como la factura los congeló) y sus líneas en orden.
 */
export interface ModifiedInvoice {
  id: string;
  number: string;
  issueDate: string;
  total: BigDecimal;
  customerId: string;
  buyer: Recipient;
  lines: LineRow[];
}

/** Una factura escrita a mano: su número (EEE-PPP-SSSSSSSSS) y su fecha; no está en la plataforma. */
export interface WrittenInvoice {
  number: string;
  issueDate: string;
}

/** La línea de la factura con ese número, o nulo. */
export function invoiceLine(invoice: ModifiedInvoice, lineNo: number): LineRow | null {
  return invoice.lines.find((line) => line.lineNo === lineNo) ?? null;
}

/** El documento modificado del sobre de la nota: enlazado a la factura, con su número y su fecha. */
export function modifiedDocumentOf(invoice: ModifiedInvoice): ModifiedDocument {
  return { documentId: invoice.id, code: DOCUMENT_TYPES.INVOICE.code, number: invoice.number, issueDate: invoice.issueDate };
}

/** El documento modificado del sobre de la nota, sin enlace. */
export function writtenModifiedDocument(written: WrittenInvoice): ModifiedDocument {
  return { documentId: null, code: DOCUMENT_TYPES.INVOICE.code, number: written.number, issueDate: written.issueDate };
}

const unprocessable = (errorCode: ErrorCode, detail: string) => new ApiException(422, errorCode, detail);

/**
 * Una nota modifica una factura de la plataforma (invoiceId, sin customerId: el comprador es el de la
 * factura) o una escrita a mano (modifiedDocument con customerId); nunca las dos ni ninguna: 400
 * MODIFIED_DOCUMENT_REQUIRED.
 */
export function requireOneModifiedDocument(
  invoiceId: string | null,
  written: WrittenInvoice | null,
  customerId: string | null,
): void {
  const fromInvoice = invoiceId !== null && written === null && customerId === null;
  const byHand = invoiceId === null && written !== null && customerId !== null;
  if (!fromInvoice && !byHand) {
    throw new ApiException(
      400,
      'MODIFIED_DOCUMENT_REQUIRED',
      'La nota lleva invoiceId, o modifiedDocument con customerId; no las dos cosas ni ninguna',
    );
  }
}

/** 422 INVALID_MODIFIED_DOCUMENT_DATE si la factura modificada es posterior a la nota. */
export function requireNotLater(modifiedDate: string, noteDate: string): void {
  if (localDateIsAfter(modifiedDate, noteDate)) {
    throw unprocessable(
      'INVALID_MODIFIED_DOCUMENT_DATE',
      'La fecha del comprobante que se modifica no puede ser posterior a la de la nota',
    );
  }
}

export class ModifiedInvoices {
  constructor(private readonly documents: FiscalDocumentRepository) {}

  /**
   * Bloquea la factura con FOR UPDATE hasta el final de la transacción de la emisión: dos notas sobre la
   * misma factura se deciden de una en una, y la segunda ve el saldo que dejó la primera. Debe correr
   * antes de reservar el secuencial. Ajena o inexistente responde 404; si no es una factura, 422
   * MODIFIED_DOCUMENT_NOT_INVOICE; de otro emisor de la empresa, 422 MODIFIED_INVOICE_OTHER_ISSUER; no
   * autorizada, 422 MODIFIED_INVOICE_NOT_AUTHORIZED.
   */
  async lockForNote(
    trx: Transaction<DB>,
    access: TenantAccess,
    invoiceId: string,
    taxpayerId: string,
  ): Promise<ModifiedInvoice> {
    const tenantId = access.tenantId;
    const locked = await this.documents.lockForProcessing(trx, tenantId, invoiceId);
    if (locked === null) throw ApiException.notFound();
    if (locked.documentType !== DOCUMENT_TYPES.INVOICE.code) {
      throw unprocessable('MODIFIED_DOCUMENT_NOT_INVOICE', 'El comprobante que se modifica no es una factura');
    }
    if (locked.taxpayerId !== taxpayerId) {
      throw unprocessable('MODIFIED_INVOICE_OTHER_ISSUER', 'La factura es de otro emisor de la empresa');
    }
    if (locked.state !== AUTHORIZED) {
      throw unprocessable('MODIFIED_INVOICE_NOT_AUTHORIZED', 'Solo se modifica una factura autorizada por el SRI');
    }
    // El comprador es el que la factura congeló: si luego se editó o se archivó el cliente, la nota no cambia.
    const invoice = await this.documents.envelope(trx, tenantId, invoiceId);
    if (invoice === null) throw ApiException.notFound();
    const { customerId } = await this.documents.links(trx, tenantId, invoiceId);
    return {
      id: invoiceId,
      number: documentNumber(invoice),
      issueDate: invoice.issueDate,
      total: requireTotals(invoice).total,
      customerId,
      buyer: invoice.recipient,
      lines: await this.documents.lines(trx, tenantId, invoiceId),
    };
  }
}
