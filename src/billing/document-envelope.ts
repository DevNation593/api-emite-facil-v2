/**
 * Sobre congelado común a todos los comprobantes (billing/DocumentEnvelope.java): lo que el documento
 * guardó al emitirse, sin lo propio de cada tipo. `recipient` es el receptor (comprador, proveedor,
 * sujeto retenido o transportista). Las fechas son `YYYY-MM-DD`.
 */
import type { BigDecimal } from '../common/big-decimal.js';
import type { DocumentType } from '../xml/document-type.js';

/** `rimpeRegime` es NONE, EMPRENDEDOR o NEGOCIO_POPULAR; los códigos opcionales y `phone` pueden ser nulos. */
export interface Issuer {
  legalName: string;
  tradeName: string | null;
  ruc: string;
  headOfficeAddress: string;
  establishmentAddress: string | null;
  accountingRequired: boolean;
  specialTaxpayerCode: string | null;
  withholdingAgentCode: string | null;
  rimpeRegime: string;
  phone: string | null;
}

/** `email` y `phone` pueden ser nulos. */
export interface Recipient {
  idType: string;
  idNumber: string;
  name: string;
  address: string | null;
  email: string | null;
  phone: string | null;
}

/** `total` no es nulo; `subtotal`, `totalDiscount` y `totalTax` pueden serlo (retención). */
export interface Totals {
  subtotal: BigDecimal | null;
  totalDiscount: BigDecimal | null;
  totalTax: BigDecimal | null;
  total: BigDecimal;
}

/** `documentId` es nulo cuando el comprobante modificado se escribió a mano. */
export interface ModifiedDocument {
  documentId: string | null;
  code: string;
  number: string;
  issueDate: string;
}

export interface DocumentEnvelope {
  type: DocumentType;
  environment: string;
  issuer: Issuer;
  accessKey: string;
  establishmentCode: string;
  emissionPointCode: string;
  sequence: number;
  issueDate: string;
  recipient: Recipient;
  totals: Totals | null;
  modified: ModifiedDocument | null;
  providerRuc: string | null;
}

/** Número del comprobante: establecimiento, punto y secuencial de nueve dígitos ("001-002-000000123"). */
export function documentNumber(envelope: DocumentEnvelope): string {
  return `${envelope.establishmentCode}-${envelope.emissionPointCode}-${String(envelope.sequence).padStart(9, '0')}`;
}

/** Los totales del sobre, que las notas necesitan (Java lanzaría NullPointerException). */
export function requireTotals(envelope: DocumentEnvelope): Totals {
  if (envelope.totals === null)
    throw new Error('El comprobante no tiene totales');
  return envelope.totals;
}

/** El comprobante que modifica la nota (Java lanzaría NullPointerException). */
export function requireModified(envelope: DocumentEnvelope): ModifiedDocument {
  if (envelope.modified === null)
    throw new Error('El comprobante no modifica a otro');
  return envelope.modified;
}

/** Un importe del sobre que la nota necesita (Java lanzaría NullPointerException). */
export function requireAmount(
  value: BigDecimal | null,
  name: string,
): BigDecimal {
  if (value === null)
    throw new Error(`Falta ${name} en los totales del comprobante`);
  return value;
}
