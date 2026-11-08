import { BigDecimal } from '../../../src/common/big-decimal.js';
import type {
  InvoiceXmlData,
  InvoiceXmlLine,
} from '../../../src/xml/invoice-xml.js';

// Traducción de xml/InvoiceXmlFixtures.java: dos líneas, dos tarifas de IVA y dos pagos.

/** Vector del doc 06: 07/10/2026, RUC 1790012345001, ambiente 1, 001-002, secuencial 123. */
export const ACCESS_KEY = '0710202601179001234500110010020000001231234567816';

export const d = (value: string): BigDecimal => BigDecimal.of(value);

export function standardLines(): InvoiceXmlLine[] {
  return [
    {
      mainCode: 'SRV-001',
      description: 'Servicio de consultoría',
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
  ];
}

/** El documento fijo, con los datos que la prueba quiera variar. */
export function invoiceData(
  overrides: Partial<InvoiceXmlData> = {},
): InvoiceXmlData {
  return {
    environment: '1',
    issuerLegalName: 'Comercial Andina S.A.',
    issuerTradeName: 'Andina',
    issuerRuc: '1790012345001',
    accessKey: ACCESS_KEY,
    documentType: '01',
    establishmentCode: '001',
    emissionPointCode: '002',
    sequence: 123,
    headOfficeAddress: 'Av. Amazonas N34-12, Quito',
    withholdingAgentCode: null,
    rimpeRegime: 'NONE',
    issueDate: '2026-10-07',
    establishmentAddress: 'Av. 10 de Agosto, Quito',
    specialTaxpayerCode: null,
    accountingRequired: false,
    customerIdType: '05',
    customerName: 'María Pérez',
    customerIdNumber: '1712345678',
    customerAddress: 'Av. República, Quito',
    subtotal: d('34.00'),
    totalDiscount: d('0.00'),
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
    total: d('37.00'),
    lines: standardLines(),
    payments: [
      { methodCode: '20', amount: d('30.00'), term: null, timeUnit: null },
      { methodCode: '01', amount: d('7.00'), term: null, timeUnit: null },
    ],
    providerRuc: null,
    ...overrides,
  };
}
