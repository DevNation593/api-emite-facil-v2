import { BigDecimal } from '../../../src/common/big-decimal.js';
import type { DocumentEnvelope } from '../../../src/billing/document-envelope.js';
import { AccessKeyParts } from '../../../src/sequence/access-key-parts.js';
import {
  DOCUMENT_TYPES,
  type DocumentType,
} from '../../../src/xml/document-type.js';
import type { CreditNoteContent } from '../../../src/notes/credit-note-content.js';
import type { DebitNoteContent } from '../../../src/notes/debit-note-content.js';

// Traducción de los ayudantes de CreditNoteXmlBuilderTest y DebitNoteXmlBuilderTest.

export const ISSUE = '2026-10-19';

export const d = (value: string): BigDecimal => BigDecimal.of(value);

export function accessKeyOf(documentType: string): string {
  return new AccessKeyParts({
    issueDate: ISSUE,
    documentType,
    ruc: '1790012345001',
    environment: '1',
    establishment: '001',
    emissionPoint: '002',
    sequence: 7,
    numericCode: '12345678',
    emissionType: '1',
  }).toAccessKey();
}

export interface EnvelopeOptions {
  providerRuc?: string | null;
  rimpe?: string;
  withholding?: string | null;
  special?: string | null;
  tradeName?: string | null;
  address?: string | null;
  accounting?: boolean;
}

function envelopeOf(
  type: DocumentType,
  totals: DocumentEnvelope['totals'],
  options: EnvelopeOptions,
): DocumentEnvelope {
  return {
    type,
    environment: '1',
    issuer: {
      legalName: 'Comercial Andina S.A.',
      tradeName: options.tradeName === undefined ? 'Andina' : options.tradeName,
      ruc: '1790012345001',
      headOfficeAddress: 'Av. Amazonas N34-12, Quito',
      establishmentAddress:
        options.address === undefined
          ? 'Av. 10 de Agosto, Quito'
          : options.address,
      accountingRequired: options.accounting ?? false,
      specialTaxpayerCode: options.special ?? null,
      withholdingAgentCode: options.withholding ?? null,
      rimpeRegime: options.rimpe ?? 'NONE',
      phone: null,
    },
    accessKey: accessKeyOf(type.code),
    establishmentCode: '001',
    emissionPointCode: '002',
    sequence: 7,
    issueDate: ISSUE,
    recipient: {
      idType: '05',
      idNumber: '1712345678',
      name: 'María Pérez',
      address: 'Av. República, Quito',
      email: null,
      phone: null,
    },
    totals,
    modified: {
      documentId: null,
      code: '01',
      number: '001-001-000000123',
      issueDate: '2026-10-01',
    },
    providerRuc: options.providerRuc ?? null,
  };
}

export function creditEnvelope(
  options: EnvelopeOptions = {},
): DocumentEnvelope {
  return envelopeOf(
    DOCUMENT_TYPES.CREDIT_NOTE,
    {
      subtotal: d('34.00'),
      totalDiscount: d('0.00'),
      totalTax: d('3.00'),
      total: d('37.00'),
    },
    options,
  );
}

export function creditContent(
  reason = 'Devolución de mercadería',
  description = 'Servicio de consultoría',
): CreditNoteContent {
  return {
    reason,
    lines: [
      {
        invoiceLineNo: 1,
        productId: null,
        mainCode: 'SRV-001',
        description,
        quantity: d('2'),
        unitPrice: d('10.00'),
        discount: d('0.00'),
        subtotal: d('20.00'),
        taxCode: '2',
        taxRateCode: '4',
        taxRate: d('15.00'),
        taxAmount: d('3.00'),
      },
      {
        invoiceLineNo: 2,
        productId: null,
        mainCode: 'LIB-001',
        description: 'Libro',
        quantity: d('1.5'),
        unitPrice: d('9.333333'),
        discount: d('0.00'),
        subtotal: d('14.00'),
        taxCode: '2',
        taxRateCode: '0',
        taxRate: d('0.00'),
        taxAmount: d('0.00'),
      },
    ],
    taxes: [
      {
        taxCode: '2',
        rateCode: '0',
        rate: d('0.00'),
        base: d('14.00'),
        amount: d('0.00'),
      },
      {
        taxCode: '2',
        rateCode: '4',
        rate: d('15.00'),
        base: d('20.00'),
        amount: d('3.00'),
      },
    ],
  };
}

export function debitEnvelope(
  providerRuc: string | null = null,
): DocumentEnvelope {
  return envelopeOf(
    DOCUMENT_TYPES.DEBIT_NOTE,
    {
      subtotal: d('15.00'),
      totalDiscount: d('0.00'),
      totalTax: d('2.25'),
      total: d('17.25'),
    },
    { providerRuc },
  );
}

export function debitContent(reason = 'Intereses de mora'): DebitNoteContent {
  return {
    reasons: [
      {
        reason,
        value: d('10.00'),
        taxCode: '2',
        taxRateCode: '4',
        taxRate: d('15.00'),
        taxAmount: d('1.50'),
      },
      {
        reason: 'Gastos de cobranza',
        value: d('5.00'),
        taxCode: '2',
        taxRateCode: '4',
        taxRate: d('15.00'),
        taxAmount: d('0.75'),
      },
    ],
    taxes: [
      {
        taxCode: '2',
        rateCode: '4',
        rate: d('15.00'),
        base: d('15.00'),
        amount: d('2.25'),
      },
    ],
    payments: [
      { methodCode: '01', amount: d('17.25'), term: null, timeUnit: null },
    ],
  };
}
