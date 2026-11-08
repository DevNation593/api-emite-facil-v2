import { SaxesParser } from 'saxes';
import { checkEnvelope } from '../../../src/xml/envelope-rules.js';
import {
  buildInvoiceXml,
  INVOICE_SCHEMA,
  type InvoiceXmlData,
} from '../../../src/xml/invoice-xml.js';
import { DOCUMENT_SCHEMAS } from '../../../src/xml/document-type.js';
import { XmlCharacterError } from '../../../src/xml/xml-writer.js';
import { XsdValidator } from '../../../src/xml/xsd-validator.js';
import { d, invoiceData, standardLines } from './invoice-fixtures.js';

// Traducción de InvoiceXmlBuilderTest: formato de factura versión 1.1.0 (ficha técnica v2.34, Anexo 3).
const EXPECTED =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<factura id="comprobante" version="1.1.0">' +
  '<infoTributaria><ambiente>1</ambiente><tipoEmision>1</tipoEmision>' +
  '<razonSocial>Comercial Andina S.A.</razonSocial><nombreComercial>Andina</nombreComercial>' +
  '<ruc>1790012345001</ruc><claveAcceso>0710202601179001234500110010020000001231234567816</claveAcceso>' +
  '<codDoc>01</codDoc><estab>001</estab><ptoEmi>002</ptoEmi><secuencial>000000123</secuencial>' +
  '<dirMatriz>Av. Amazonas N34-12, Quito</dirMatriz></infoTributaria>' +
  '<infoFactura><fechaEmision>07/10/2026</fechaEmision>' +
  '<dirEstablecimiento>Av. 10 de Agosto, Quito</dirEstablecimiento>' +
  '<obligadoContabilidad>NO</obligadoContabilidad>' +
  '<tipoIdentificacionComprador>05</tipoIdentificacionComprador>' +
  '<razonSocialComprador>María Pérez</razonSocialComprador>' +
  '<identificacionComprador>1712345678</identificacionComprador>' +
  '<direccionComprador>Av. República, Quito</direccionComprador>' +
  '<totalSinImpuestos>34.00</totalSinImpuestos><totalDescuento>0.00</totalDescuento>' +
  '<totalConImpuestos>' +
  '<totalImpuesto><codigo>2</codigo><codigoPorcentaje>0</codigoPorcentaje>' +
  '<baseImponible>14.00</baseImponible><valor>0.00</valor></totalImpuesto>' +
  '<totalImpuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje>' +
  '<baseImponible>20.00</baseImponible><valor>3.00</valor></totalImpuesto>' +
  '</totalConImpuestos><propina>0.00</propina><importeTotal>37.00</importeTotal><moneda>DOLAR</moneda>' +
  '<pagos><pago><formaPago>20</formaPago><total>30.00</total></pago>' +
  '<pago><formaPago>01</formaPago><total>7.00</total></pago></pagos></infoFactura>' +
  '<detalles>' +
  '<detalle><codigoPrincipal>SRV-001</codigoPrincipal><descripcion>Servicio de consultoría</descripcion>' +
  '<cantidad>2.000000</cantidad><precioUnitario>10.000000</precioUnitario><descuento>0.00</descuento>' +
  '<precioTotalSinImpuesto>20.00</precioTotalSinImpuesto><impuestos><impuesto><codigo>2</codigo>' +
  '<codigoPorcentaje>4</codigoPorcentaje><tarifa>15.00</tarifa><baseImponible>20.00</baseImponible>' +
  '<valor>3.00</valor></impuesto></impuestos></detalle>' +
  '<detalle><codigoPrincipal>LIB-001</codigoPrincipal><descripcion>Libro</descripcion>' +
  '<cantidad>1.500000</cantidad><precioUnitario>9.333333</precioUnitario><descuento>0.00</descuento>' +
  '<precioTotalSinImpuesto>14.00</precioTotalSinImpuesto><impuestos><impuesto><codigo>2</codigo>' +
  '<codigoPorcentaje>0</codigoPorcentaje><tarifa>0.00</tarifa><baseImponible>14.00</baseImponible>' +
  '<valor>0.00</valor></impuesto></impuestos></detalle>' +
  '</detalles></factura>';

const validator = new XsdValidator();
const xml = (data: InvoiceXmlData) => buildInvoiceXml(data).toString('utf8');

async function expectValid(data: InvoiceXmlData): Promise<void> {
  const bytes = buildInvoiceXml(data);
  const result = await validator.validate(bytes, INVOICE_SCHEMA);
  expect(result.errors).toEqual([]);
  expect([...checkEnvelope(bytes, INVOICE_SCHEMA)]).toEqual([]);
}

/** Texto del primer elemento con ese nombre, leído con un parser que decodifica las entidades. */
function textOf(bytes: Buffer, element: string): string {
  const parser = new SaxesParser();
  let current = '';
  let found: string | undefined;
  let inside = false;
  parser.on('opentag', (tag) => {
    if (found === undefined && tag.name === element) {
      inside = true;
      current = '';
    }
  });
  parser.on('text', (text) => {
    if (inside) current += text;
  });
  parser.on('closetag', (tag) => {
    if (inside && tag.name === element) {
      inside = false;
      found = current;
    }
  });
  parser.write(bytes.toString('utf8')).close();
  return found as string;
}

it('produce el XML esperado', () => {
  expect(xml(invoiceData())).toBe(EXPECTED);
  expect(INVOICE_SCHEMA).toBe(DOCUMENT_SCHEMAS.INVOICE_1_1_0);
});

it('el resultado es válido contra el XSD y las reglas del sobre', async () => {
  await expectValid(invoiceData());
});

it('omite los elementos opcionales sin valor', async () => {
  const data = invoiceData({
    issuerTradeName: null,
    establishmentAddress: null,
    customerAddress: ' ',
  });
  const text = xml(data);
  for (const name of [
    'nombreComercial',
    'dirEstablecimiento',
    'direccionComprador',
    'contribuyenteEspecial',
    'agenteRetencion',
    'contribuyenteRimpe',
    'infoAdicional',
  ]) {
    expect(text).not.toContain(name);
  }
  await expectValid(data);
});

it('incluye las leyendas fiscales en el orden del XSD', async () => {
  const data = invoiceData({
    accountingRequired: true,
    specialTaxpayerCode: '5368',
    withholdingAgentCode: '1',
    rimpeRegime: 'EMPRENDEDOR',
  });
  const text = xml(data);
  expect(text).toContain(
    '<dirMatriz>Av. Amazonas N34-12, Quito</dirMatriz><agenteRetencion>1</agenteRetencion>' +
      '<contribuyenteRimpe>CONTRIBUYENTE RÉGIMEN RIMPE</contribuyenteRimpe></infoTributaria>',
  );
  expect(text).toContain(
    '<contribuyenteEspecial>5368</contribuyenteEspecial><obligadoContabilidad>SI</obligadoContabilidad>',
  );
  await expectValid(data);
});

it('negocio popular usa su propia leyenda y un régimen desconocido se rechaza', () => {
  expect(xml(invoiceData({ rimpeRegime: 'NEGOCIO_POPULAR' }))).toContain(
    '<contribuyenteRimpe>CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE</contribuyenteRimpe>',
  );
  expect(() => buildInvoiceXml(invoiceData({ rimpeRegime: 'OTRO' }))).toThrow(
    XmlCharacterError,
  );
  expect(() => buildInvoiceXml(invoiceData({ rimpeRegime: 'OTRO' }))).toThrow(
    'Régimen RIMPE desconocido: OTRO',
  );
});

it('el plazo va después del total del pago', async () => {
  const data = invoiceData({
    payments: [
      { methodCode: '20', amount: d('30.00'), term: d('30'), timeUnit: 'dias' },
      { methodCode: '01', amount: d('7.00'), term: null, timeUnit: null },
    ],
  });
  expect(xml(data)).toContain(
    '<pago><formaPago>20</formaPago><total>30.00</total><plazo>30.00</plazo>' +
      '<unidadTiempo>dias</unidadTiempo></pago><pago><formaPago>01</formaPago><total>7.00</total></pago>',
  );
  await expectValid(data);
});

it('añade el RUC del proveedor como campo adicional', async () => {
  const data = invoiceData({ providerRuc: '1790099999001' });
  expect(
    xml(data).endsWith(
      '</detalles><infoAdicional><campoAdicional nombre="RUC Proveedor">1790099999001</campoAdicional>' +
        '</infoAdicional></factura>',
    ),
  ).toBe(true);
  await expectValid(data);
});

it('escapa los caracteres especiales y el texto vuelve intacto al leerlo', async () => {
  const name = "Ñandú & Hijos <\"S.A.\"> 'O'Brien' ✅ 😀";
  const lines = standardLines();
  lines[0] = {
    ...lines[0]!,
    description: 'Café & té <frío>',
    unitPrice: d('10.00'),
  };
  const data = invoiceData({ issuerLegalName: name, lines });
  const bytes = buildInvoiceXml(data);

  expect(bytes.toString('utf8')).toContain('Ñandú &amp; Hijos &lt;');
  expect(bytes.toString('utf8')).not.toContain('& Hijos');
  expect(textOf(bytes, 'razonSocial')).toBe(name);
  expect(textOf(bytes, 'descripcion')).toBe('Café & té <frío>');
  await expectValid(data);
});

it('rechaza los caracteres que XML no admite', () => {
  expect(() =>
    buildInvoiceXml(invoiceData({ issuerLegalName: 'Comercial\u0000Andina' })),
  ).toThrow(XmlCharacterError);
  expect(() =>
    buildInvoiceXml(invoiceData({ issuerLegalName: 'Comercial\u0007Andina' })),
  ).toThrow('Carácter no admitido en XML: U+7');
  expect(() =>
    buildInvoiceXml(invoiceData({ issuerLegalName: 'Comercial\u0000Andina' })),
  ).toThrow('Carácter no admitido en XML: U+0');
});

it('rechaza un sustituto suelto con su punto de código en minúsculas', () => {
  expect(() =>
    buildInvoiceXml(invoiceData({ customerName: 'a\ud800b' })),
  ).toThrow('Carácter no admitido en XML: U+d800');
  expect(() =>
    buildInvoiceXml(invoiceData({ customerName: 'a\udfffb' })),
  ).toThrow('Carácter no admitido en XML: U+dfff');
  expect(() =>
    buildInvoiceXml(invoiceData({ customerName: 'U+fffe: ￾' })),
  ).toThrow('Carácter no admitido en XML: U+fffe');
  // Un par sustituto es un solo carácter válido.
  expect(xml(invoiceData({ customerName: '😀' }))).toContain(
    '<razonSocialComprador>😀</razonSocialComprador>',
  );
});

it('los mismos datos dan los mismos bytes', () => {
  expect(
    buildInvoiceXml(invoiceData()).equals(buildInvoiceXml(invoiceData())),
  ).toBe(true);
});

it('queda por debajo del límite de tamaño con 500 líneas', () => {
  const line = standardLines()[0]!;
  const data = invoiceData({ lines: Array.from({ length: 500 }, () => line) });
  // Límite de envío individual de la ficha: 320 KB por comprobante.
  expect(buildInvoiceXml(data).length).toBeLessThan(320 * 1024);
});

it('escribe cantidad y precio con seis decimales y el resto con dos, mitad hacia arriba', () => {
  const line = {
    ...standardLines()[0]!,
    quantity: d('1.2345675'),
    unitPrice: d('0.0000005'),
    discount: d('0.005'),
    subtotal: d('20.005'),
    taxRate: d('12'),
    taxAmount: d('-0.001'),
  };
  const text = xml(invoiceData({ lines: [line] }));
  expect(text).toContain(
    '<cantidad>1.234568</cantidad><precioUnitario>0.000001</precioUnitario>',
  );
  expect(text).toContain(
    '<descuento>0.01</descuento><precioTotalSinImpuesto>20.01</precioTotalSinImpuesto>',
  );
  expect(text).toContain(
    '<tarifa>12.00</tarifa><baseImponible>20.01</baseImponible><valor>0.00</valor>',
  );
});

it('rechaza una fecha que no es YYYY-MM-DD', () => {
  expect(() =>
    buildInvoiceXml(invoiceData({ issueDate: '07/10/2026' })),
  ).toThrow('Fecha no válida');
});
