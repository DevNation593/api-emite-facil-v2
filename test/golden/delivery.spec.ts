import { readFileSync } from 'node:fs';
import type { DocumentEnvelope } from '../../src/billing/document-envelope.js';
import { BigDecimal } from '../../src/common/big-decimal.js';
import { buildAuthorizedXml } from '../../src/delivery/authorized-xml.js';
import { validAddress } from '../../src/delivery/delivery-config.js';
import { buildDeliveryEmail, headerSafe } from '../../src/delivery/delivery-email.js';
import type { SriEnvironment } from '../../src/sri/sri-environment.js';
import { documentTypeOf } from '../../src/xml/document-type.js';

// Lo que la entrega escribe o decide, generado con el código Java (tools/golden-generator, familia delivery). La
// parte `mailer` la comprueba test/integration/delivery/smtp-delivery-mailer.int.spec.ts.
interface EmailCase {
  fileStem: string;
  displayName: string;
  type: string;
  legalName: string;
  tradeName: string | null;
  recipientName: string;
  total: string | null;
  email: {
    from: string;
    fromName: string;
    to: string;
    subject: string;
    text: string;
    attachments: Array<{ filename: string; contentType: string; content: string }>;
  };
}
const golden = JSON.parse(readFileSync(new URL('./delivery.json', import.meta.url), 'utf8')) as {
  addresses: Array<{ address: string | null; valid: boolean }>;
  headers: Array<{ value: string | null; max: number; result: string }>;
  emails: EmailCase[];
  authorizedXml: Array<{
    authorizationNumber: string | null;
    authorizedAt: string | null;
    environment: SriEnvironment;
    signed: string | null;
    xml: string | null;
    error: string | null;
  }>;
};

const ACCESS_KEY = '0710202601179001234500110010020000001231234567816';

it.each(golden.addresses)('dirección $address: $valid', ({ address, valid }) => {
  expect(validAddress(address)).toBe(valid);
});

it.each(golden.headers)('cabecera $value (máximo $max)', ({ value, max, result }) => {
  expect(headerSafe(value, max)).toBe(result);
});

it.each(golden.emails.map((c, i) => [i, c] as const))('correo %i', (_i, c) => {
  const envelope: DocumentEnvelope = {
    type: documentTypeOf(c.type),
    environment: '1',
    issuer: {
      legalName: c.legalName,
      tradeName: c.tradeName,
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
    issueDate: '2026-01-07',
    recipient: {
      idType: '05',
      idNumber: '1712345678',
      name: c.recipientName,
      address: 'Quito',
      email: 'cliente@example.test',
      phone: null,
    },
    totals:
      c.total === null
        ? null
        : {
            subtotal: BigDecimal.of('33.00'),
            totalDiscount: BigDecimal.ZERO,
            totalTax: BigDecimal.of('4.00'),
            total: BigDecimal.of(c.total),
          },
    modified: null,
    providerRuc: '1790099999001',
  };
  const email = buildDeliveryEmail(
    'facturas@plataforma.test',
    { envelope, authorizationNumber: ACCESS_KEY, authorizedAt: '2026-01-07T20:15:30.000000' },
    c.displayName,
    c.fileStem,
    'cliente@example.test',
    Buffer.from('pdf'),
    Buffer.from('xml'),
  );
  expect({
    ...email,
    attachments: email.attachments.map((a) => ({ ...a, content: a.content.toString('utf8') })),
  }).toEqual(c.email);
});

describe('XML autorizado', () => {
  const decoded = golden.authorizedXml.map((c, i) => [i, c] as const);
  // Un XML firmado que no fuera UTF-8 no existe: lo escribe el propio firmador. Java sustituiría sus bytes y
  // NestJS los conserva.
  const valid = decoded.filter(
    ([, c]) => c.signed === null || Buffer.from(Buffer.from(c.signed, 'base64').toString('utf8')).equals(Buffer.from(c.signed, 'base64')),
  );

  it('solo queda fuera el caso que no es UTF-8', () => {
    expect(decoded.length - valid.length).toBe(1);
  });

  it.each(valid)('caso %i', (_i, c) => {
    const build = () =>
      buildAuthorizedXml(
        c.authorizationNumber,
        c.authorizedAt,
        c.environment,
        c.signed === null ? null : Buffer.from(c.signed, 'base64'),
      );
    if (c.error !== null) expect(build).toThrow(c.error);
    else expect(build().toString('utf8')).toBe(Buffer.from(c.xml!, 'base64').toString('utf8'));
  });
});
