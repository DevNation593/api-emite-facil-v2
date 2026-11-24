import type { Issuer, Recipient } from '../billing/document-envelope.js';
import { BigDecimal } from '../common/big-decimal.js';
import { isIsoControl, isJavaWhitespace, javaTrim } from '../common/java-text.js';
import { ecuadorDateTime, localDateText } from '../common/java-time.js';
import { type Align, type Cell, type FontStyle, padding, PdfTable } from './pdf-table.js';

/*
 * Piezas comunes del RIDE, como delivery/RideLayout.java: letras y colores, cabecera con emisor, RUC, título,
 * número, autorización y código de barras de la clave de acceso, bloques con franja azul de título (cliente,
 * información adicional), detalle, totales y pie. La factura y las notas las componen. Usa Helvetica, así que los
 * caracteres que esa letra no tiene (fuera de CP1252) se omiten.
 */

/** Lo que las filas de totales necesitan de cada impuesto (InvoiceXmlTax y NoteTax). */
export interface RideTax {
  rateCode: string;
  rate: BigDecimal;
  base: BigDecimal;
  amount: BigDecimal;
}

/** Azul de las franjas de título y de las etiquetas de los totales. */
const NAVY = '#28367f';
/** Fondo de las filas de datos. */
const PALE = '#eef2f5';
/** Fondo de la franja con el tipo de comprobante. */
const BAND_GREY = '#e0e4ea';
/** Raya fina bajo cada fila del detalle. */
const RULE = '#d6dbe2';
const WHITE = '#ffffff';
const BLACK = '#000000';

const TITLE: FontStyle = { bold: true, size: 11, color: BLACK };
const BOLD: FontStyle = { bold: true, size: 8, color: BLACK };
const NORMAL: FontStyle = { bold: false, size: 8, color: BLACK };
const SMALL: FontStyle = { bold: false, size: 7, color: BLACK };
const NAME: FontStyle = { bold: true, size: 15, color: NAVY };
const RUC: FontStyle = { bold: true, size: 12, color: WHITE };
const ON_NAVY: FontStyle = { bold: true, size: 8, color: WHITE };
const AMOUNT: FontStyle = { bold: true, size: 9, color: BLACK };
const GRAND_AMOUNT: FontStyle = { bold: true, size: 10, color: BLACK };
const LINK: FontStyle = { bold: false, size: 7, color: '#0000ee', underline: true };

/** Consulta pública de validez de comprobantes del SRI. */
const SRI_VALIDATION_URL =
  'https://declaraciones.sri.gob.ec/comprobantes-electronicos-internet/publico/validezComprobantes.jsf';

/** Tarifas cuyo subtotal sale siempre, aunque sea cero. */
const FIXED_SUBTOTAL_RATES = ['15%', '0%', '5%'];
/** Tarifas cuyo IVA sale siempre, aunque sea cero. */
const FIXED_VAT_RATES = ['15%', '5%'];

const CELL_PADDING = 2;

/** Hueco entre bloques del documento. */
export const SPACER = { spacer: 8 } as const;

/**
 * Cabecera: a la izquierda el nombre del emisor en grande y sus datos; a la derecha la franja del RUC, el tipo y
 * número de comprobante, la autorización y la clave de acceso con su código de barras.
 */
export function header(
  issuer: Issuer,
  title: string,
  number: string,
  environment: string,
  accessKey: string,
  authorizationNumber: string,
  authorizedAt: string,
): PdfTable {
  // El nombre ocupa el lugar del logo, que el emisor aún no puede cargar.
  const issuerBox = box();
  const name = centered(issuer.tradeName ?? issuer.legalName, NAME);
  issuerBox.add({ ...name, padding: { ...name.padding, top: 14, bottom: 14 } });
  issuerBox.add(labelled('RAZÓN SOCIAL: ', issuer.legalName));
  issuerBox.add(labelled('NOMBRE COMERCIAL: ', issuer.tradeName));
  // La dirección del establecimiento solo se separa de la matriz cuando es otra.
  if (issuer.establishmentAddress === null || issuer.establishmentAddress === issuer.headOfficeAddress) {
    issuerBox.add(labelled('DIRECCIÓN: ', issuer.headOfficeAddress));
  } else {
    issuerBox.add(labelled('DIRECCIÓN MATRIZ: ', issuer.headOfficeAddress));
    issuerBox.add(labelled('DIRECCIÓN SUCURSAL: ', issuer.establishmentAddress));
  }
  issuerBox.add(labelled('OBLIGADO A LLEVAR CONTABILIDAD: ', issuer.accountingRequired ? 'SI' : 'NO'));
  if (issuer.specialTaxpayerCode !== null) {
    issuerBox.add(labelled('CONTRIBUYENTE ESPECIAL NRO: ', issuer.specialTaxpayerCode));
  }
  if (issuer.withholdingAgentCode !== null) {
    issuerBox.add(labelled('AGENTE DE RETENCIÓN RESOLUCIÓN NO. ', issuer.withholdingAgentCode));
  }
  const rimpe = rimpeLegend(issuer.rimpeRegime);
  if (rimpe !== null) issuerBox.add(labelled(rimpe, ''));
  issuerBox.add(labelled('TELÉFONO: ', issuer.phone));

  const fiscal = box();
  fiscal.add(band(`R.U.C. ${issuer.ruc}`, RUC, NAVY));
  fiscal.add(band(title, TITLE, BAND_GREY));
  fiscal.add(centered(number, NORMAL));
  fiscal.add(centered('Número Autorización SRI', NORMAL));
  fiscal.add(digits(authorizationNumber));
  fiscal.add(labelled('FECHA Y HORA DE AUTORIZACIÓN: ', ecuadorDateTime(authorizedAt)));
  fiscal.add(labelled('AMBIENTE: ', environment === '2' ? 'PRODUCCIÓN' : 'PRUEBAS'));
  fiscal.add(labelled('ESTADO: ', 'AUTORIZADO'));
  fiscal.add(labelled('EMISIÓN: ', 'NORMAL'));
  fiscal.add(line('CLAVE DE ACCESO:', BOLD));
  fiscal.add({
    content: { kind: 'barcode', value: accessKey },
    padding: { top: 2, right: 0.25, bottom: 1, left: 0.25 },
  });
  fiscal.add(digits(accessKey));

  const table = new PdfTable([49, 51]);
  const left = wrap(issuerBox);
  table.add({ ...left, padding: { ...left.padding, right: 6 } });
  const right = wrap(fiscal);
  table.add({ ...right, padding: { ...right.padding, left: 6 } });
  return table;
}

/** «DATOS DEL CLIENTE»: nombre, identificación según su tipo y fecha de emisión; la dirección va en la información adicional. */
export function recipientTable(recipient: Pick<Recipient, 'name' | 'idType' | 'idNumber'>, issueDate: string): PdfTable {
  return infoTable('DATOS DEL CLIENTE', [
    ['RAZÓN SOCIAL:', recipient.name],
    [`${idLabel(recipient.idType)}:`, recipient.idNumber],
    ['FECHA DE EMISIÓN:', localDateText(issueDate)],
  ]);
}

/**
 * «INFORMACIÓN ADICIONAL» con el correo, la dirección y el teléfono del cliente y el RUC del proveedor. Los nulos
 * se omiten, salvo el teléfono: su fila queda aunque esté vacía, como en el modelo.
 */
export function additionalInfo(
  email: string | null,
  address: string | null,
  phone: string | null,
  providerRuc: string | null,
): PdfTable {
  const rows: Array<[string, string | null]> = [];
  if (email !== null) rows.push(['Correo Electrónico', email]);
  if (address !== null) rows.push(['Dirección', address]);
  rows.push(['Teléfono', phone]);
  if (providerRuc !== null) rows.push(['RUC Proveedor', providerRuc]);
  return infoTable('INFORMACIÓN ADICIONAL', rows);
}

/** «FORMA DE PAGO» con su plazo y unidad de tiempo; las filas con `payment`. */
export function paymentsTable(): PdfTable {
  return detailTable([64, 12, 12, 12], 'FORMA DE PAGO', 'PLAZO', 'TIEMPO', 'VALOR');
}

/**
 * Una forma de pago por su nombre del catálogo o, si no lo tiene, por su código; `term` y `timeUnit`, el plazo y
 * su unidad, quedan en blanco si son nulos.
 */
export function payment(
  payments: PdfTable,
  code: string,
  name: string | undefined,
  value: BigDecimal,
  term: BigDecimal | null,
  timeUnit: string | null,
): void {
  payments.add(text(name ?? code, 'left'));
  payments.add(text(term === null ? '' : amount(term, 0), 'center'));
  payments.add(text(timeUnit, 'center'));
  payments.add(text(amount(value, 2), 'right'));
}

/** Bloque a todo el ancho: franja azul con el título y una fila de fondo claro por etiqueta y valor. */
export function infoTable(title: string, rows: ReadonlyArray<readonly [string, string | null]>): PdfTable {
  const table = new PdfTable([18, 82]);
  table.add({ ...band(title, ON_NAVY, NAVY), colspan: 2 });
  for (const [label, value] of rows) {
    table.add(pale([{ text: clean(label), font: BOLD }]));
    table.add(pale([{ text: clean(value), font: NORMAL }]));
  }
  return table;
}

/** Tabla con encabezado azul que se repite en cada página; las filas las añade quien llama con `text`. */
export function detailTable(widths: readonly number[], ...titles: string[]): PdfTable {
  const table = new PdfTable(widths, { headerRows: 1 });
  for (const title of titles) table.add(band(title, ON_NAVY, NAVY));
  return table;
}

/** Tabla de totales de dos columnas, vacía: etiqueta sobre azul y valor a la derecha. */
export function totalsTable(): PdfTable {
  return new PdfTable([64, 36]);
}

/**
 * Subtotales por tarifa, siempre con las filas 15 %, 0 %, 5 %, no objeto y exento (en cero si no hay base); otra
 * tarifa que tenga el comprobante entra después de la del 5 %.
 */
export function subtotalRows(totals: PdfTable, taxes: readonly RideTax[]): void {
  const bases = new Map<string, BigDecimal>();
  for (const rate of FIXED_SUBTOTAL_RATES) bases.set(`IVA ${rate}`, BigDecimal.ZERO);
  for (const tax of taxes) {
    if (tax.rateCode !== '6' && tax.rateCode !== '7') merge(bases, rateLabel(tax.rateCode, tax.rate), tax.base);
  }
  bases.set(rateLabel('6', BigDecimal.ZERO), baseOf(taxes, '6'));
  bases.set(rateLabel('7', BigDecimal.ZERO), baseOf(taxes, '7'));
  for (const [label, base] of bases) total(totals, `Subtotal ${label}`, base);
}

/** IVA por tarifa, siempre con las filas 15 % y 5 %; otra tarifa mayor que cero entra a continuación. */
export function vatRows(totals: PdfTable, taxes: readonly RideTax[]): void {
  const amounts = new Map<string, BigDecimal>();
  for (const rate of FIXED_VAT_RATES) amounts.set(`IVA ${rate}`, BigDecimal.ZERO);
  for (const tax of taxes) {
    if (tax.rate.signum() > 0) merge(amounts, `IVA ${percent(tax.rate)}`, tax.amount);
  }
  for (const [label, value] of amounts) total(totals, label, value);
}

function merge(into: Map<string, BigDecimal>, label: string, value: BigDecimal): void {
  const before = into.get(label);
  into.set(label, before === undefined ? value : before.add(value));
}

function baseOf(taxes: readonly RideTax[], rateCode: string): BigDecimal {
  return taxes
    .filter((tax) => tax.rateCode === rateCode)
    .reduce((sum, tax) => sum.add(tax.base), BigDecimal.ZERO);
}

export function total(totals: PdfTable, label: string, value: BigDecimal): void {
  totalRow(totals, label, value, AMOUNT);
}

/** Última fila de los totales, con el importe más grande. */
export function grandTotal(totals: PdfTable, label: string, value: BigDecimal): void {
  totalRow(totals, label, value, GRAND_AMOUNT);
}

/**
 * Cierre del RIDE, que si no cabe al final de una página pasa entero a la siguiente: los totales a la derecha;
 * debajo y a todo el ancho, `below` (información adicional, formas de pago); luego, centradas, las leyendas propias
 * del documento (en negrita), la de verificación en el SRI y la del medio ambiente.
 */
export function footer(below: PdfTable, totals: PdfTable, ...legends: string[]): PdfTable {
  const table = new PdfTable([68, 32], { keepTogether: true });
  table.add(gap());
  table.add(wrap(totals));
  table.add(wide(gap()));
  table.add(wide(wrap(below)));
  table.add(wide(gap()));
  for (const legend of legends) table.add(wide(centered(legend, BOLD)));
  table.add(
    wide(centered('Para verificar la validez y legalidad de sus comprobantes puede consultar en el SRI:', SMALL)),
  );
  table.add(wide(centered(SRI_VALIDATION_URL, LINK)));
  const environment = wide(centered('Cuidemos el medio ambiente.', SMALL));
  table.add({ ...environment, padding: { ...environment.padding, top: 8 } });
  return table;
}

function wide(cell: Cell): Cell {
  return { ...cell, colspan: 2 };
}

/** Celda sin borde que envuelve una tabla. */
export function wrap(table: PdfTable): Cell {
  return { content: { kind: 'table', table }, padding: padding(0) };
}

/** Celda vacía sin borde para separar bloques apilados. */
export function gap(): Cell {
  return { content: { kind: 'text', runs: [{ text: ' ', font: SMALL }] }, padding: padding(CELL_PADDING) };
}

/** Los códigos 6 y 7 del catálogo de IVA no son tarifas: no objeto y exento (ficha, Tabla 17). */
export function rateLabel(rateCode: string, rate: BigDecimal): string {
  if (rateCode === '6') return 'No Objeto IVA';
  if (rateCode === '7') return 'Exento IVA';
  return `IVA ${percent(rate)}`;
}

export function percent(rate: BigDecimal): string {
  return `${amount(rate, 0)}%`;
}

/** Importe con al menos los decimales indicados; conserva más si el valor los tiene (precios con seis). */
export function amount(value: BigDecimal, minScale: number): string {
  const stripped = value.stripTrailingZeros();
  return stripped.toFixed(Math.max(minScale, stripped.scale));
}

/** Tipo de identificación del comprador (ficha, Tabla 6) como etiqueta; los demás, genérica. */
function idLabel(idType: string | null): string {
  switch (idType) {
    case '04':
      return 'RUC';
    case '05':
      return 'CÉDULA';
    case '06':
      return 'PASAPORTE';
    default:
      return 'IDENTIFICACIÓN';
  }
}

function rimpeLegend(regime: string | null): string | null {
  switch (regime) {
    case 'EMPRENDEDOR':
      return 'CONTRIBUYENTE RÉGIMEN RIMPE';
    case 'NEGOCIO_POPULAR':
      return 'CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE';
    default:
      return null;
  }
}

function totalRow(totals: PdfTable, label: string, value: BigDecimal, font: FontStyle): void {
  totals.add({
    content: { kind: 'text', runs: [{ text: clean(label), font: ON_NAVY }] },
    align: 'right',
    padding: padding(3),
    fill: NAVY,
    bottomBorder: { color: WHITE, width: 0.5 },
  });
  totals.add({
    content: { kind: 'text', runs: [{ text: amount(value, 2), font }] },
    align: 'right',
    padding: padding(3),
  });
}

/** Tabla de una columna sin bordes, para apilar líneas. */
export function box(): PdfTable {
  return new PdfTable([1]);
}

function line(value: string | null, font: FontStyle): Cell {
  return { content: { kind: 'text', runs: [{ text: clean(value), font }] }, padding: padding(1.5) };
}

/** Una cifra larga (clave de acceso, autorización) entera y centrada en su línea: nunca se parte. */
function digits(value: string): Cell {
  return { ...centered(value, SMALL), noWrap: true };
}

/** Fila de fondo claro: etiqueta en negrita seguida del valor. */
function labelled(label: string, value: string | null): Cell {
  return pale([
    { text: label, font: BOLD },
    { text: clean(value), font: NORMAL },
  ]);
}

/** Celda del detalle, con una raya fina debajo. */
export function text(value: string | null, align: Align): Cell {
  return {
    content: { kind: 'text', runs: [{ text: clean(value), font: NORMAL }] },
    align,
    padding: padding(3),
    bottomBorder: { color: RULE, width: 0.5 },
  };
}

function centered(value: string | null, font: FontStyle): Cell {
  return { ...line(value, font), align: 'center' };
}

/** Franja de título: texto centrado sobre un fondo de color. */
function band(value: string, font: FontStyle, fill: string): Cell {
  return {
    content: { kind: 'text', runs: [{ text: clean(value), font }] },
    align: 'center',
    middle: true,
    padding: { ...padding(3), bottom: 4 },
    fill,
    bottomBorder: { color: WHITE, width: 0.5 },
  };
}

/** Fondo claro con una línea blanca debajo que separa la fila de la siguiente. */
function pale(runs: Array<{ text: string; font: FontStyle }>): Cell {
  return {
    content: { kind: 'text', runs },
    padding: padding(2.5),
    fill: PALE,
    bottomBorder: { color: WHITE, width: 1 },
  };
}

/** Los caracteres de CP1252 que no están en Latin-1 (de U+0152 a U+2122). */
const CP1252_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

function inCp1252(character: string): boolean {
  const code = character.codePointAt(0)!;
  return code < 0x80 || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRAS.has(character);
}

/**
 * Deja el texto en lo que el PDF puede mostrar: los caracteres de control pasan a espacio y los que la letra no
 * tiene se omiten. No se añade ni se quita nada más: una palabra que no cabe en su celda la reparte la propia tabla
 * entre varias líneas.
 */
export function clean(value: string | null): string {
  if (value === null) return '';
  let out = '';
  for (const character of value) {
    if (isIsoControl(character) || isJavaWhitespace(character)) out += ' ';
    else if (inCp1252(character)) out += character;
  }
  return javaTrim(out);
}
