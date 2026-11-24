import { buildInvoiceRide, type RideData } from '../../../src/delivery/invoice-ride.js';
import type { InvoiceXmlData } from '../../../src/xml/invoice-xml.js';
import { inspectPdf, pdfText } from '../../support/pdf-inspect.js';
import { ACCESS_KEY, d, invoiceData } from '../xml/invoice-fixtures.js';

// Traducción de delivery/RidePdfBuilderTest.java. El aspecto lo compara test/golden/ride.spec.ts.
const PAYMENT_NAMES = new Map([
  ['20', 'OTROS CON UTILIZACIÓN DEL SISTEMA FINANCIERO'],
  ['01', 'SIN UTILIZACION DEL SISTEMA FINANCIERO'],
]);

function ride(invoice: InvoiceXmlData, overrides: Partial<RideData> = {}): RideData {
  return {
    invoice,
    authorizationNumber: ACCESS_KEY,
    authorizedAt: '2026-10-07T20:15:30.000000',
    customerEmail: 'cliente@example.test',
    customerPhone: '0991234567',
    issuerPhone: '(02) 245-6789',
    paymentMethodNames: PAYMENT_NAMES,
    ...overrides,
  };
}

const textOf = async (data: RideData) => pdfText(await buildInvoiceRide(data));

function expectAll(text: string, parts: string[]): void {
  for (const part of parts) expect(text).toContain(part);
}

it('containsEveryRequiredField', async () => {
  const text = await textOf(ride(invoiceData()));

  expectAll(text, [
    'R.U.C. 1790012345001',
    'FACTURA',
    '001-002-000000123',
    'Número Autorización SRI',
    'FECHA Y HORA DE AUTORIZACIÓN',
    '07/10/2026 15:15:30',
    'AMBIENTE:',
    'PRUEBAS',
    'ESTADO:',
    'AUTORIZADO',
    'EMISIÓN:',
    'NORMAL',
    'CLAVE DE ACCESO',
    ACCESS_KEY,
  ]);
  expectAll(text, [
    'RAZÓN SOCIAL:',
    'Comercial Andina S.A.',
    'NOMBRE COMERCIAL:',
    'Andina',
    'DIRECCIÓN MATRIZ:',
    'Av. Amazonas N34-12, Quito',
    'DIRECCIÓN SUCURSAL:',
    'Av. 10 de Agosto, Quito',
    'OBLIGADO A LLEVAR CONTABILIDAD:',
    'NO',
    'TELÉFONO: (02) 245-6789',
  ]);
  expectAll(text, ['DATOS DEL CLIENTE', 'María Pérez', 'CÉDULA:', '1712345678', 'FECHA DE EMISIÓN:', '07/10/2026']);
  expectAll(text, [
    'CÓDIGO',
    'CANTIDAD',
    'DESCRIPCIÓN',
    'V. UNITARIO',
    'V. TOTAL',
    'SRV-001',
    'Servicio de consultoría',
    '2.00',
    '10.00',
    '20.00',
    'LIB-001',
    'Libro',
    '1.50',
    '9.333333',
    '14.00',
  ]);
  expectAll(text, [
    'Subtotal IVA 15%',
    'Subtotal IVA 0%',
    'Subtotal IVA 5%',
    'Subtotal No Objeto IVA',
    'Subtotal Exento IVA',
    'Propina',
    'Descuento',
    'IVA 15%',
    '3.00',
    'IVA 5%',
    'TOTAL',
    '37.00',
  ]);
  expectAll(text, [
    'INFORMACIÓN ADICIONAL',
    'Correo Electrónico',
    'cliente@example.test',
    'Dirección',
    'Av. República, Quito',
    'Teléfono 0991234567',
  ]);
  expectAll(text, [
    'FORMA DE PAGO',
    'PLAZO',
    'TIEMPO',
    'VALOR',
    'OTROS CON UTILIZACIÓN DEL SISTEMA FINANCIERO',
    '30.00',
    'SIN UTILIZACION DEL SISTEMA FINANCIERO',
    '7.00',
  ]);
  expectAll(text, [
    'Favor remitir sus pagos y retenciones a nombre de "Comercial Andina S.A."',
    'validezComprobantes.jsf',
    'Cuidemos el medio ambiente.',
  ]);
  // La estructura del modelo: sin columna de descuento ni subtotal sin impuestos, la forma de pago por su nombre.
  for (const absent of ['DESCUENTO', 'Subtotal sin impuestos', '20 - OTROS']) expect(text).not.toContain(absent);
});

it('paymentTermIsPrintedWithItsUnit', async () => {
  const text = await textOf(
    ride(
      invoiceData({
        payments: [
          { methodCode: '20', amount: d('30.00'), term: d('30.00'), timeUnit: 'dias' },
          { methodCode: '01', amount: d('7.00'), term: d('1.50'), timeUnit: 'meses' },
        ],
      }),
    ),
  );

  expect(text).toContain('OTROS CON UTILIZACIÓN DEL SISTEMA FINANCIERO 30 dias 30.00');
  expect(text).toContain('SIN UTILIZACION DEL SISTEMA FINANCIERO 1.5 meses 7.00');
});

it('sameAddressIsPrintedOnce', async () => {
  const text = await textOf(ride(invoiceData({ establishmentAddress: 'Av. Amazonas N34-12, Quito' })));

  expect(text).toContain('DIRECCIÓN: Av. Amazonas N34-12, Quito');
  expect(text).not.toContain('DIRECCIÓN MATRIZ');
});

it('isAValidPdfWithABarcode', async () => {
  const pdf = await buildInvoiceRide(ride(invoiceData()));

  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const { pages, title } = await inspectPdf(pdf);
  expect(title).toBe('Factura 001-002-000000123');
  expect(pages.length).toBe(1);
  // 24 pares de cifras, la última sola, los cambios de juego, el control y la parada: 88 barras.
  expect(pages[0]!.rects.filter((rect) => rect.color === '#000000').length).toBe(88);
});

it('optionalLegendsAppearOnlyWhenPresent', async () => {
  const plain = await textOf(ride(invoiceData()));
  for (const absent of ['CONTRIBUYENTE ESPECIAL', 'AGENTE DE RETENCIÓN', 'RIMPE', 'RUC Proveedor']) {
    expect(plain).not.toContain(absent);
  }

  const full = await textOf(
    ride(
      invoiceData({
        specialTaxpayerCode: '5368',
        withholdingAgentCode: '1',
        rimpeRegime: 'EMPRENDEDOR',
        accountingRequired: true,
        providerRuc: '1790099999001',
      }),
    ),
  );

  expectAll(full, [
    'CONTRIBUYENTE ESPECIAL NRO: 5368',
    'AGENTE DE RETENCIÓN RESOLUCIÓN NO. 1',
    'CONTRIBUYENTE RÉGIMEN RIMPE',
    'RUC Proveedor',
    '1790099999001',
    'OBLIGADO A LLEVAR CONTABILIDAD: SI',
  ]);
});

it('fixedTaxRowsAlwaysAppearAndOtherRatesAreAdded', async () => {
  const tax = (rateCode: string, rate: string, base: string, amount: string) => ({
    taxCode: '2',
    rateCode,
    rate: d(rate),
    base: d(base),
    amount: d(amount),
  });
  const text = await textOf(
    ride(
      invoiceData({
        subtotal: d('30.00'),
        totalDiscount: d('1.25'),
        taxes: [tax('6', '0.00', '10.00', '0.00'), tax('7', '0.00', '20.00', '0.00'), tax('8', '8.00', '5.00', '0.40')],
        total: d('35.40'),
      }),
    ),
  );

  // Las filas del modelo salen aunque estén en cero; la tarifa del 8 % entra tras la del 5 %.
  expect(text).toContain(
    'Subtotal IVA 15% 0.00 Subtotal IVA 0% 0.00 Subtotal IVA 5% 0.00 Subtotal IVA 8% 5.00' +
      ' Subtotal No Objeto IVA 10.00 Subtotal Exento IVA 20.00 Propina 0.00 Descuento 1.25' +
      ' IVA 15% 0.00 IVA 5% 0.00 IVA 8% 0.40 TOTAL 35.40',
  );
});

it('manyLinesFlowOntoMorePages', async () => {
  const lines = Array.from({ length: 300 }, (_, i) => ({
    mainCode: `COD-${i + 1}`,
    description: `Producto número ${i + 1}`,
    quantity: d('1'),
    unitPrice: d('1.00'),
    discount: d('0.00'),
    subtotal: d('1.00'),
    taxCode: '2',
    taxRateCode: '4',
    taxRate: d('15.00'),
    taxAmount: d('0.15'),
  }));
  const pdf = await buildInvoiceRide(ride(invoiceData({ lines })));

  expect((await inspectPdf(pdf)).pages.length).toBeGreaterThan(1);
  expectAll(await pdfText(pdf), [
    'COD-1 1.00 Producto número 1',
    'COD-300 1.00 Producto número 300',
    'Cuidemos el medio ambiente.',
  ]);
});

it('oddCharactersNeverBreakTheRide', async () => {
  const text = await textOf(
    ride(
      invoiceData({
        issuerLegalName: 'Ñandú & Hijos <S.A.> "Cía."',
        issuerTradeName: 'Línea\r\nBcc: otra 😀 東京',
        customerAddress: 'x'.repeat(300),
        lines: [
          {
            mainCode: 'A\u0000B',
            description: 'Café\tcon leche — «especial» €5',
            quantity: d('1'),
            unitPrice: d('1.00'),
            discount: d('0.00'),
            subtotal: d('1.00'),
            taxCode: '2',
            taxRateCode: '4',
            taxRate: d('15.00'),
            taxAmount: d('0.15'),
          },
        ],
      }),
    ),
  );

  expectAll(text, ['Ñandú & Hijos <S.A.> "Cía."', 'Línea', 'Bcc: otra', 'Café', 'con leche — «especial» €5']);
  // La palabra interminable se reparte en varias líneas, pero no pierde ni gana caracteres.
  expect(/x{299,}/.exec(text.replace(/\s/g, ''))![0].length).toBe(300);
});

it('longValuesArePrintedWhole', async () => {
  const longEmail = 'contabilidad.cuentas.por.pagar@grupo-empresarial-andino.com.ec';

  // Un dato sin espacios no se parte con espacios inventados.
  expect(await textOf(ride(invoiceData(), { customerEmail: longEmail }))).toContain(longEmail);
});

it('unauthorizedDataIsRejected', async () => {
  for (const missing of [{ authorizationNumber: null }, { authorizationNumber: ' ' }, { authorizedAt: null }]) {
    await expect(buildInvoiceRide(ride(invoiceData(), missing))).rejects.toThrow(
      'Solo un comprobante autorizado tiene RIDE',
    );
  }
});

it('missingOptionalDataIsLeftOut', async () => {
  const text = await textOf(
    ride(invoiceData(), {
      customerEmail: null,
      customerPhone: null,
      issuerPhone: null,
      paymentMethodNames: new Map(),
    }),
  );

  // Sin correo no hay fila de correo; una forma de pago sin nombre sale por su código.
  expect(text).not.toContain('Correo Electrónico');
  expectAll(text, ['INFORMACIÓN ADICIONAL', 'FORMA DE PAGO', '20 30.00']);
});

it('dos RIDE a la vez no se mezclan', async () => {
  const [first, second] = await Promise.all([
    textOf(ride(invoiceData({ customerName: 'Primero' }))),
    textOf(ride(invoiceData({ customerName: 'Segundo' }))),
  ]);
  expect(first).toContain('Primero');
  expect(first).not.toContain('Segundo');
  expect(second).toContain('Segundo');
});
