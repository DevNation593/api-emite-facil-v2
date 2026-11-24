import type { RideEnvelope } from '../../../src/billing/ride-envelope.js';
import { buildDeliveryEmail } from '../../../src/delivery/delivery-email.js';
import { DOCUMENT_TYPES } from '../../../src/xml/document-type.js';
import { ACCESS_KEY, d } from '../xml/invoice-fixtures.js';

// Traducción de delivery/DeliveryEmailFactoryTest.java.
const PDF = Buffer.from('%PDF-1.5 ride', 'utf8');
const XML = Buffer.from('<autorizacion/>', 'utf8');

function ride(tradeName: string | null, withTotals = true): RideEnvelope {
  return {
    envelope: {
      type: DOCUMENT_TYPES.INVOICE,
      environment: '1',
      issuer: {
        legalName: 'Comercial Andina S.A.',
        tradeName,
        ruc: '1790012345001',
        headOfficeAddress: 'Quito',
        establishmentAddress: 'Quito',
        accountingRequired: false,
        specialTaxpayerCode: null,
        withholdingAgentCode: null,
        rimpeRegime: 'NONE',
        phone: null,
      },
      accessKey: ACCESS_KEY,
      establishmentCode: '001',
      emissionPointCode: '002',
      sequence: 123,
      issueDate: '2026-10-07',
      recipient: {
        idType: '05',
        idNumber: '1712345678',
        name: 'María Pérez',
        address: 'Quito',
        email: 'cliente@example.test',
        phone: null,
      },
      totals: withTotals
        ? { subtotal: d('33.00'), totalDiscount: d('0'), totalTax: d('4.00'), total: d('37.00') }
        : null,
      modified: null,
      providerRuc: '1790099999001',
    },
    authorizationNumber: ACCESS_KEY,
    authorizedAt: '2026-10-07T20:15:30.000000',
  };
}

const build = (data: RideEnvelope, displayName = 'Factura', fileStem = 'factura') =>
  buildDeliveryEmail('facturas@plataforma.test', data, displayName, fileStem, 'cliente@example.test', PDF, XML);

it('subjectTextAndAttachments', () => {
  const email = build(ride('Andina'));

  expect(email.from).toBe('facturas@plataforma.test');
  expect(email.fromName).toBe('Andina');
  expect(email.to).toBe('cliente@example.test');
  expect(email.subject).toBe('Factura 001-002-000000123 de Andina');
  for (const part of [
    'María Pérez',
    'Comercial Andina S.A.',
    '1790012345001',
    '001-002-000000123',
    '07/10/2026',
    '37.00',
    ACCESS_KEY,
    'RIDE',
    'XML',
    'le ha emitido la factura electrónica 001-002-000000123',
  ]) {
    expect(email.text).toContain(part);
  }
  expect(email.attachments).toEqual([
    { filename: 'factura-001-002-000000123.pdf', contentType: 'application/pdf', content: PDF },
    { filename: `${ACCESS_KEY}.xml`, contentType: 'application/xml', content: XML },
  ]);
});

it('issuerWithoutTradeNameUsesItsLegalName', () => {
  const email = build(ride(null));

  expect(email.subject).toBe('Factura 001-002-000000123 de Comercial Andina S.A.');
  expect(email.fromName).toBe('Comercial Andina S.A.');
});

it('namesCannotInjectHeaders', () => {
  const email = build(ride(`Andina\r\nBcc: x@evil.test\u0000${'x'.repeat(400)}`));

  // eslint-disable-next-line no-control-regex
  expect(email.subject).not.toMatch(/[\r\n\u0000]/);
  expect(email.subject.startsWith('Factura 001-002-000000123 de Andina Bcc:')).toBe(true);
  expect(email.subject.length).toBeLessThanOrEqual(200);
  // eslint-disable-next-line no-control-regex
  expect(email.fromName).not.toMatch(/[\r\n\u0000]/);
  expect(email.fromName.length).toBeLessThanOrEqual(120);
});

it('otherTypeUsesItsName', () => {
  const email = build(ride('Andina'), 'Nota de crédito', 'nota-credito');

  expect(email.subject.startsWith('Nota de crédito ')).toBe(true);
  expect(email.text).toContain('le ha emitido la nota de crédito electrónica');
  expect(email.attachments[0]!.filename).toBe('nota-credito-001-002-000000123.pdf');
});

it('noTotalLineWithoutTotal', () => {
  expect(build(ride('Andina', false), 'Guía de remisión', 'guia-remision').text).not.toContain('Valor total');
});
