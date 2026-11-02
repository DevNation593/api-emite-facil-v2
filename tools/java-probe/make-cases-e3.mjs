#!/usr/bin/env node
// Escribe cases/e3.json, los casos de sondeo de E3 (facturas, notas y consulta de comprobantes).
// Uso: node tools/java-probe/make-cases-e3.mjs
// Los casos corren en este orden contra Java y contra NestJS: los secuenciales dependen de él.
// El escenario (runScenario con hooks) ya emitió y autorizó la factura `{invoiceId}` de 12.08.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('./cases/e3.json', import.meta.url));
const cases = [];
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const INVOICES = '/api/v1/invoices';
const CREDITS = '/api/v1/credit-notes';
const DEBITS = '/api/v1/debit-notes';
const DOCUMENTS = '/api/v1/documents';
const TOTAL = '12.08'; // 10.50 con IVA del 15 %: subtotal 10.50, IVA 1.58 y total 12.08.

let counter = 0;
const slug = (text) =>
  text
    .normalize('NFD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 60);

/**
 * Un POST de emisión con su propia clave `sondeo-<n>-<nombre>`. `key` la fija (o, con null, la
 * quita; con una lista, la repite). Con `rawBody` el texto se envía tal cual.
 */
function post(name, path, body, extra = {}) {
  const { key, headers, rawBody, capture, auth } = extra;
  const keyHeader =
    key === null ? {} : { 'idempotency-key': key === undefined ? `sondeo-${++counter}-${slug(name)}` : key };
  const probe = { name, method: 'POST', path, auth: auth ?? 'owner' };
  const all = { ...keyHeader, ...(headers ?? {}) };
  if (Object.keys(all).length > 0) probe.headers = all;
  if (capture) probe.capture = capture;
  if (rawBody !== undefined) probe.rawBody = rawBody;
  else probe.body = body;
  cases.push(probe);
}
const get = (name, path, query, extra = {}) =>
  cases.push({ name, method: 'GET', path, ...(query === undefined ? {} : { query }), auth: 'owner', ...extra });
const other = (method, path) => cases.push({ name: `${method} ${path}`, method, path, auth: 'owner' });
/** El cuerpo con `token` (un número JSON escrito tal cual) donde `make` puso el marcador. */
const numberBody = (make, token) => JSON.stringify(make('@@')).replace('"@@"', token);

// Cuerpos válidos. Cada llamada devuelve un objeto nuevo.
const line = (over = {}) => ({ productId: '{productId}', quantity: '1', ...over });
const payment = (over = {}) => ({ methodCode: '01', amount: TOTAL, ...over });
const invoice = (over = {}) => ({
  taxpayerId: '{taxpayerId}',
  establishmentCode: '001',
  emissionPointCode: '001',
  customerId: '{customerId}',
  lines: [line()],
  payments: [payment()],
  ...over,
});
const creditLine = (over = {}) => ({ invoiceLineNo: 1, quantity: '0.1', ...over });
const credit = (over = {}) => ({
  taxpayerId: '{taxpayerId}',
  establishmentCode: '001',
  emissionPointCode: '001',
  reason: 'Devolución parcial',
  invoiceId: '{invoiceId}',
  lines: [creditLine()],
  ...over,
});
const modified = (over = {}) => ({ code: '01', number: '001-001-000000099', issueDate: '2026-10-01', ...over });
const creditManual = (over = {}) => ({
  taxpayerId: '{taxpayerId}',
  establishmentCode: '001',
  emissionPointCode: '001',
  reason: 'Devolución de factura externa',
  modifiedDocument: modified(),
  customerId: '{customerId}',
  lines: [{ productId: '{productId}', quantity: '1' }],
  ...over,
});
const reason = (over = {}) => ({ reason: 'Intereses de mora', value: '5.00', ivaRateCode: '4', ...over });
const debitPayment = (over = {}) => ({ methodCode: '01', amount: '5.75', ...over });
const debit = (over = {}) => ({
  taxpayerId: '{taxpayerId}',
  establishmentCode: '001',
  emissionPointCode: '001',
  invoiceId: '{invoiceId}',
  reasons: [reason()],
  payments: [debitPayment()],
  ...over,
});
const debitManual = (over = {}) => ({
  taxpayerId: '{taxpayerId}',
  establishmentCode: '001',
  emissionPointCode: '001',
  modifiedDocument: modified(),
  customerId: '{customerId}',
  reasons: [reason()],
  payments: [debitPayment()],
  ...over,
});
const without = (body, ...names) => {
  const copy = { ...body };
  for (const name of names) delete copy[name];
  return copy;
};

// Respuestas 2xx: una de cada ruta, con el id guardado para consultarlo después.
post('ok POST /invoices', INVOICES, invoice(), { key: 'sondeo-ok-factura', capture: 'okInvoiceId' });
post('ok POST /credit-notes sobre factura', CREDITS, credit({ lines: [creditLine({ quantity: '0.5' })] }), { key: 'sondeo-ok-nc', capture: 'okCreditId' });
post('ok POST /credit-notes a mano', CREDITS, creditManual(), { key: 'sondeo-ok-nc-mano', capture: 'okCreditManualId' });
post('ok POST /debit-notes sobre factura', DEBITS, debit(), { key: 'sondeo-ok-nd', capture: 'okDebitId' });
post('ok POST /debit-notes a mano', DEBITS, debitManual(), { key: 'sondeo-ok-nd-mano', capture: 'okDebitManualId' });
get('ok GET /documents', DOCUMENTS);
for (const [label, id] of Object.entries({
  'factura de la plataforma': '{invoiceId}',
  'factura emitida': '{okInvoiceId}',
  'nota de crédito sobre factura': '{okCreditId}',
  'nota de crédito a mano': '{okCreditManualId}',
  'nota de débito sobre factura': '{okDebitId}',
  'nota de débito a mano': '{okDebitManualId}',
}))
  get(`ok GET /documents/{id} ${label}`, `${DOCUMENTS}/${id}`);

const afterOk = cases.length;

// Cabecera Idempotency-Key (con un cuerpo válido), en las tres rutas.
post('key ausente', INVOICES, invoice(), { key: null });
post('key ausente nota de crédito', CREDITS, credit(), { key: null });
post('key ausente nota de débito', DEBITS, debit(), { key: null });
post('key vacía', INVOICES, invoice(), { key: '' });
post('key de espacios', INVOICES, invoice(), { key: '   ' });
post('key de 100 caracteres', INVOICES, invoice(), { key: 'k'.repeat(100) });
post('key de 101 caracteres', INVOICES, invoice(), { key: 'k'.repeat(101) });
post('key con barra', INVOICES, invoice(), { key: 'a/b' });
post('key con espacio', INVOICES, invoice(), { key: 'a b' });
post('key con eñe', INVOICES, invoice(), { key: 'a-ñ' });
post('key repetida', INVOICES, invoice(), { key: ['sondeo-dos-a', 'sondeo-dos-b'] });
post('key con espacios alrededor', INVOICES, invoice(), { key: ' sondeo-espacios ' });
post('key inválida nota de crédito', CREDITS, credit(), { key: 'a/b' });
post('key inválida nota de débito', DEBITS, debit(), { key: 'a/b' });
post('key ausente con cuerpo inválido', INVOICES, {}, { key: null });
post('key ausente con cuerpo inválido nota de crédito', CREDITS, {}, { key: null });
post('key ausente con cuerpo inválido nota de débito', DEBITS, {}, { key: null });
post('key inválida con cuerpo inválido', INVOICES, {}, { key: 'a/b' });
post('key válida con cuerpo inválido', INVOICES, {});
post('key ausente con JSON malformado', INVOICES, undefined, { key: null, rawBody: '{' });
post('key ausente sin cuerpo', INVOICES, undefined, { key: null, rawBody: '' });

// Ids: número, booleano, objeto, mayúsculas y sin guiones (más malformado, nulo, vacío y desconocido).
const idOdd = (name) => ({
  numero: 123,
  booleano: true,
  objeto: { a: 1 },
  malformado: 'x',
  nulo: null,
  vacio: '',
  desconocido: UNKNOWN,
  mayusculas: `{${name}Upper}`,
  sinGuiones: `{${name}NoDash}`,
});
const idFields = [
  ['invoices', INVOICES, invoice, 'taxpayerId'],
  ['invoices', INVOICES, invoice, 'customerId'],
  ['credit-notes', CREDITS, credit, 'taxpayerId'],
  ['credit-notes', CREDITS, credit, 'invoiceId'],
  ['credit-notes a mano', CREDITS, creditManual, 'customerId'],
  ['debit-notes', DEBITS, debit, 'taxpayerId'],
  ['debit-notes', DEBITS, debit, 'invoiceId'],
  ['debit-notes a mano', DEBITS, debitManual, 'customerId'],
];
for (const [label, path, make, field] of idFields)
  for (const [kind, value] of Object.entries(idOdd(field))) post(`${label} ${field} ${kind}`, path, make({ [field]: value }));
for (const [kind, value] of Object.entries(idOdd('productId'))) {
  post(`invoices lines productId ${kind}`, INVOICES, invoice({ lines: [line({ productId: value })] }));
  post(`credit-notes a mano lines productId ${kind}`, CREDITS, creditManual({ lines: [{ productId: value, quantity: '1' }] }));
}
for (const [kind, value] of Object.entries(idOdd('invoiceId'))) post(`invoices replacesDocumentId ${kind}`, INVOICES, invoice({ replacesDocumentId: value }));
post('invoices replacesDocumentId válido', INVOICES, invoice({ replacesDocumentId: '{invoiceId}' }));
post('invoices replacesDocumentId de una factura RESERVED', INVOICES, invoice({ replacesDocumentId: '{okInvoiceId}' }));
post('credit-notes con invoiceId y modifiedDocument', CREDITS, credit({ modifiedDocument: modified() }));
post('credit-notes sin invoiceId ni modifiedDocument', CREDITS, without(credit(), 'invoiceId'));
post('credit-notes a mano sin customerId', CREDITS, without(creditManual(), 'customerId'));
post('debit-notes con invoiceId y modifiedDocument', DEBITS, debit({ modifiedDocument: modified() }));
post('debit-notes sin invoiceId ni modifiedDocument', DEBITS, without(debit(), 'invoiceId'));
post('debit-notes a mano sin customerId', DEBITS, without(debitManual(), 'customerId'));

// issueDate.
const dates = {
  sinCero: '2026-11-2',
  barras: '02/11/2026',
  conHora: '2026-11-02T10:00:00',
  vacia: '',
  numero: 20000,
  arreglo: [2026, 11, 2],
  nula: null,
  anterior: '2026-10-01',
  futura: '2099-01-01',
  inexistente: '2026-02-30',
  anio5: '12026-01-01',
};
for (const [kind, value] of Object.entries(dates)) {
  post(`invoices issueDate ${kind}`, INVOICES, invoice({ issueDate: value }));
  post(`credit-notes issueDate ${kind}`, CREDITS, credit({ issueDate: value }));
  post(`debit-notes issueDate ${kind}`, DEBITS, debit({ issueDate: value }));
}
const modifiedDates = { sinCero: '2026-10-1', barras: '01/10/2026', numero: 20000, arreglo: [2026, 10, 1], nula: null, ausente: undefined, futura: '2099-01-01' };
for (const [kind, value] of Object.entries(modifiedDates)) {
  post(`credit-notes modifiedDocument issueDate ${kind}`, CREDITS, creditManual({ modifiedDocument: modified({ issueDate: value }) }));
  post(`debit-notes modifiedDocument issueDate ${kind}`, DEBITS, debitManual({ modifiedDocument: modified({ issueDate: value }) }));
}

// invoiceLineNo.
const lineNos = { numero: 1, texto: '1', decimal: 1.5, booleano: true, letras: 'x', cero: 0, negativo: -1, grande: 2147483648, nulo: null, inexistente: 99 };
for (const [kind, value] of Object.entries(lineNos)) post(`credit-notes invoiceLineNo ${kind}`, CREDITS, credit({ lines: [creditLine({ invoiceLineNo: value })] }));
for (const [kind, token] of Object.entries({ unoCero: '1.0', unoExponente: '1e0', textoConCero: '"01"' }))
  post(`credit-notes invoiceLineNo ${kind}`, CREDITS, undefined, { rawBody: JSON.stringify(credit({ lines: [creditLine({ invoiceLineNo: '@@' })] })).replace('"@@"', token) });
post('credit-notes invoiceLineNo repetido', CREDITS, credit({ lines: [creditLine(), creditLine()] }));
post('credit-notes línea con productId e invoiceLineNo', CREDITS, credit({ lines: [creditLine({ productId: '{productId}' })] }));
post('credit-notes a mano con invoiceLineNo', CREDITS, creditManual({ lines: [{ productId: '{productId}', invoiceLineNo: 1, quantity: '1' }] }));
post('credit-notes línea vacía', CREDITS, credit({ lines: [{}] }));

// Cantidades e importes como número JSON (2, 2.50, 1e2, 123456789012.123456) y como "007".
const numbers = { dos: '2', dosCincuenta: '2.50', exponente: '1e2', dieciochoDigitos: '123456789012.123456' };
const numericFields = [
  ['invoices lines quantity', INVOICES, (v) => invoice({ lines: [line({ quantity: v })] })],
  ['invoices lines unitPrice', INVOICES, (v) => invoice({ lines: [line({ unitPrice: v })] })],
  ['invoices lines discount', INVOICES, (v) => invoice({ lines: [line({ discount: v })] })],
  ['invoices payments amount', INVOICES, (v) => invoice({ payments: [payment({ amount: v })] })],
  ['invoices payments term', INVOICES, (v) => invoice({ payments: [payment({ term: v, timeUnit: 'dias' })] })],
  ['credit-notes lines quantity', CREDITS, (v) => credit({ lines: [creditLine({ quantity: v })] })],
  ['credit-notes lines unitPrice', CREDITS, (v) => credit({ lines: [creditLine({ unitPrice: v })] })],
  ['credit-notes lines discount', CREDITS, (v) => credit({ lines: [creditLine({ discount: v })] })],
  ['debit-notes reasons value', DEBITS, (v) => debit({ reasons: [reason({ value: v })] })],
  ['debit-notes payments amount', DEBITS, (v) => debit({ payments: [debitPayment({ amount: v })] })],
  ['debit-notes payments term', DEBITS, (v) => debit({ payments: [debitPayment({ term: v, timeUnit: 'dias' })] })],
];
for (const [label, path, make] of numericFields) {
  for (const [kind, token] of Object.entries(numbers)) post(`${label} número ${kind}`, path, undefined, { rawBody: numberBody(make, token) });
  post(`${label} cadena con ceros`, path, make('007'));
}

// Listas: objeto, texto, nulo, vacía, con un nulo y por encima del máximo.
const many = (count, make) => Array.from({ length: count }, () => make());
const listKinds = (valid, max) => ({
  objeto: {},
  texto: 'x',
  nulo: null,
  vacia: [],
  conNulo: [null],
  conNumero: [1],
  conTexto: ['x'],
  enElMaximo: many(max, valid),
  sobreElMaximo: many(max + 1, valid),
});
for (const [kind, value] of Object.entries(listKinds(() => line(), 500))) post(`invoices lines ${kind}`, INVOICES, invoice({ lines: value }));
for (const [kind, value] of Object.entries(listKinds(() => payment({ amount: '0.01' }), 20))) post(`invoices payments ${kind}`, INVOICES, invoice({ payments: value }));
for (const [kind, value] of Object.entries(listKinds(() => creditLine({ quantity: '0.001' }), 200))) post(`credit-notes lines ${kind}`, CREDITS, credit({ lines: value }));
for (const [kind, value] of Object.entries(listKinds(() => reason(), 20))) post(`debit-notes reasons ${kind}`, DEBITS, debit({ reasons: value }));
for (const [kind, value] of Object.entries(listKinds(() => debitPayment({ amount: '5.75' }), 1))) post(`debit-notes payments ${kind}`, DEBITS, debit({ payments: value }));
post('debit-notes payments 2 pagos', DEBITS, debit({ payments: [debitPayment({ amount: '2.75' }), debitPayment({ amount: '3.00' })] }));
post('invoices lines con productos repetidos', INVOICES, invoice({ lines: [line(), line()], payments: [payment({ amount: '24.15' })] }));

// modifiedDocument.
for (const [route, path, make] of [['credit-notes', CREDITS, creditManual], ['debit-notes', DEBITS, debitManual]]) {
  const md = {
    texto: 'x',
    nulo: null,
    objetoVacio: {},
    arreglo: [],
    codigo04: modified({ code: '04' }),
    codigoNumerico: modified({ code: 1 }),
    sinCodigo: without(modified(), 'code'),
    sinNumero: without(modified(), 'number'),
    sinFecha: without(modified(), 'issueDate'),
    numeroMalformado: modified({ number: '1-1-1' }),
    numeroConLetras: modified({ number: '00a-001-000000099' }),
    propiedadDesconocida: { ...modified(), documentId: UNKNOWN },
  };
  for (const [kind, value] of Object.entries(md)) post(`${route} modifiedDocument ${kind}`, path, make({ modifiedDocument: value }));
}

// Propiedades desconocidas, en el cuerpo y en una línea, motivo o pago.
post('invoices propiedad desconocida', INVOICES, invoice({ extra: 1 }));
post('invoices propiedad desconocida en línea', INVOICES, invoice({ lines: [line({ extra: 1 })] }));
post('invoices propiedad desconocida en pago', INVOICES, invoice({ payments: [payment({ extra: 1 })] }));
post('invoices tenantId en el cuerpo', INVOICES, invoice({ tenantId: UNKNOWN }));
post('credit-notes propiedad desconocida', CREDITS, credit({ extra: 1 }));
post('credit-notes propiedad desconocida en línea', CREDITS, credit({ lines: [creditLine({ extra: 1 })] }));
post('debit-notes propiedad desconocida', DEBITS, debit({ extra: 1 }));
post('debit-notes propiedad desconocida en motivo', DEBITS, debit({ reasons: [reason({ extra: 1 })] }));
post('debit-notes propiedad desconocida en pago', DEBITS, debit({ payments: [debitPayment({ extra: 1 })] }));

// Códigos y textos.
for (const [kind, value] of Object.entries({ numero: 1, vacio: '', espacios: ' 001 ', corto: '01', largo: '0001', letras: 'a01', nulo: null, objeto: {} })) {
  post(`invoices establishmentCode ${kind}`, INVOICES, invoice({ establishmentCode: value }));
  post(`credit-notes emissionPointCode ${kind}`, CREDITS, credit({ emissionPointCode: value }));
  post(`debit-notes establishmentCode ${kind}`, DEBITS, debit({ establishmentCode: value }));
}
post('invoices establecimiento inexistente', INVOICES, invoice({ establishmentCode: '099' }));
post('invoices punto de emisión inexistente', INVOICES, invoice({ emissionPointCode: '099' }));
for (const [kind, value] of Object.entries({ minusculas: 'usd', otra: 'EUR', numero: 1, vacia: '', larga: 'USDD', nula: null })) post(`invoices currency ${kind}`, INVOICES, invoice({ currency: value }));
const reasons = { vacio: '', espacios: '   ', nulo: null, numero: 1, control: 'a\u0001b', saltoDeLinea: 'a\nb', de300: 'r'.repeat(300), de301: 'r'.repeat(301), conEspacios: '  Motivo  ', sustituto: '\ud800' };
for (const [kind, value] of Object.entries(reasons)) {
  post(`credit-notes reason ${kind}`, CREDITS, credit({ reason: value }));
  post(`debit-notes reasons reason ${kind}`, DEBITS, debit({ reasons: [reason({ reason: value })] }));
}
for (const [kind, value] of Object.entries({ vacio: '', cinco: '5', letras: 'ab', cuatro: '4', cero: '0', noExiste: '9999', cincoDigitos: '00004', nulo: null, numero: 4 }))
  post(`debit-notes ivaRateCode ${kind}`, DEBITS, debit({ reasons: [reason({ ivaRateCode: value })] }));
for (const [kind, value] of Object.entries({ ausente: undefined, letras: 'ab', tres: '001', desconocida: '99', numero: 1, nula: null, vacia: '' }))
  post(`invoices payments methodCode ${kind}`, INVOICES, invoice({ payments: [payment({ methodCode: value })] }));
post('invoices pago en cero', INVOICES, invoice({ payments: [payment({ amount: '0' })] }));
post('invoices pagos que no suman', INVOICES, invoice({ payments: [payment({ amount: '12.07' })] }));
post('invoices plazo sin unidad', INVOICES, invoice({ payments: [payment({ term: '30' })] }));
post('invoices unidad sin plazo', INVOICES, invoice({ payments: [payment({ timeUnit: 'dias' })] }));
post('invoices plazo y unidad', INVOICES, invoice({ payments: [payment({ term: '30', timeUnit: 'dias' })] }));
post('invoices unidad de 11 caracteres', INVOICES, invoice({ payments: [payment({ term: '30', timeUnit: 'd'.repeat(11) })] }));
post('invoices unidad con control', INVOICES, invoice({ payments: [payment({ term: '30', timeUnit: 'd\u0001' })] }));
post('invoices lines unitPrice y discount propios', INVOICES, invoice({ lines: [line({ unitPrice: '5.000000', discount: '1.00' })], payments: [payment({ amount: '4.60' })] }));
post('invoices lines con unitPrice cero', INVOICES, invoice({ lines: [line({ unitPrice: '0' })], payments: [payment({ amount: '0' })] }));
post('invoices lines descuento mayor que el subtotal', INVOICES, invoice({ lines: [line({ discount: '99.00' })] }));
for (const [kind, value] of Object.entries({ cero: '0', negativo: '-1', siete: '1.1234567', tres: '1.123', coma: '1,5', exponente: '1e2', espacio: ' 1', mas: '+1', trece: '1234567890123', nulo: null, vacio: '' }))
  post(`invoices lines quantity texto ${kind}`, INVOICES, invoice({ lines: [line({ quantity: value })] }));
for (const [kind, value] of Object.entries({ cero: '0', mayorQueLaFactura: '1.000001', negativo: '-1', siete: '1.1234567' }))
  post(`credit-notes lines quantity texto ${kind}`, CREDITS, credit({ lines: [creditLine({ quantity: value })] }));
post('credit-notes unitPrice mayor que el de la factura', CREDITS, credit({ lines: [creditLine({ unitPrice: '10.500001' })] }));
post('credit-notes discount menor que el proporcional', CREDITS, credit({ lines: [creditLine({ discount: '0.00' })] }));
post('credit-notes supera el saldo', CREDITS, credit({ lines: [creditLine({ quantity: '1' })] }));
post('credit-notes factura inexistente', CREDITS, credit({ invoiceId: UNKNOWN }));
post('credit-notes factura RESERVED', CREDITS, credit({ invoiceId: '{okInvoiceId}' }));
post('credit-notes de una nota', CREDITS, credit({ invoiceId: '{okCreditId}' }));
post('credit-notes issueDate anterior a la factura', CREDITS, credit({ issueDate: '2020-01-01' }));
post('debit-notes factura RESERVED', DEBITS, debit({ invoiceId: '{okInvoiceId}' }));
post('debit-notes factura inexistente', DEBITS, debit({ invoiceId: UNKNOWN }));
post('debit-notes pago que no suma', DEBITS, debit({ payments: [debitPayment({ amount: '5.74' })] }));
post('debit-notes plazo sin unidad', DEBITS, debit({ payments: [debitPayment({ term: '30' })] }));
post('debit-notes con dos motivos', DEBITS, debit({ reasons: [reason(), reason({ reason: 'Otro' })], payments: [debitPayment({ amount: '11.50' })] }));
post('credit-notes con dos líneas del mismo producto a mano', CREDITS, creditManual({ lines: [{ productId: '{productId}', quantity: '1' }, { productId: '{productId}', quantity: '1' }] }));
post('debit-notes valor cero', DEBITS, debit({ reasons: [reason({ value: '0' })], payments: [debitPayment({ amount: '0' })] }));
post('cuerpo arreglo invoices', INVOICES, [1]);
post('cuerpo nulo invoices', INVOICES, null);
post('cuerpo texto invoices', INVOICES, 'x');
post('cuerpo vacío invoices', INVOICES, {});
post('cuerpo vacío credit-notes', CREDITS, {});
post('cuerpo vacío debit-notes', DEBITS, {});
post('JSON malformado invoices', INVOICES, undefined, { rawBody: '{"taxpayerId":' });
post('sin cuerpo credit-notes', CREDITS, undefined, { rawBody: '' });
post('content-type texto invoices', INVOICES, undefined, { rawBody: '{}', headers: { 'content-type': 'text/plain' } });
post('sin autenticación invoices', INVOICES, invoice(), { key: 'sondeo-sin-auth', auth: 'none' });
post('sin autenticación credit-notes', CREDITS, credit(), { key: 'sondeo-sin-auth-nc', auth: 'none' });
post('sin autenticación debit-notes', DEBITS, debit(), { key: 'sondeo-sin-auth-nd', auth: 'none' });

// Repetición de la clave. Va justo después de los 2xx, mientras la factura aún tiene saldo para notas.
const repeatStart = cases.length;
const sameKey = (name, path, first, second, key) => {
  post(`${name} primera`, path, first, { key });
  post(`${name} segunda`, path, second, { key });
};
const bigInvoice = (quantity, amount) => invoice({ lines: [line({ quantity })], payments: [payment({ amount })] });
sameKey('repetida invoices mismo cuerpo', INVOICES, bigInvoice('3', '36.23'), bigInvoice('3', '36.23'), 'sondeo-repetida');
{
  const a = bigInvoice('4', '48.30');
  const reordered = { payments: a.payments, lines: [{ quantity: '4', productId: '{productId}' }], customerId: a.customerId, emissionPointCode: '001', establishmentCode: '001', taxpayerId: a.taxpayerId };
  sameKey('repetida invoices otro orden', INVOICES, a, reordered, 'sondeo-orden');
}
post('repetida invoices cantidad texto primera', INVOICES, bigInvoice('2', '24.15'), { key: 'sondeo-cantidad' });
post('repetida invoices cantidad número segunda', INVOICES, undefined, { key: 'sondeo-cantidad', rawBody: numberBody((v) => bigInvoice(v, '24.15'), '2') });
post('repetida invoices cantidad 2.0 como texto', INVOICES, bigInvoice('2.0', '24.15'), { key: 'sondeo-cantidad' });
post('repetida invoices cantidad 2.50 número primera', INVOICES, undefined, { key: 'sondeo-cantidad-decimal', rawBody: numberBody((v) => bigInvoice(v, '30.19'), '2.50') });
post('repetida invoices cantidad 2.50 texto segunda', INVOICES, bigInvoice('2.50', '30.19'), { key: 'sondeo-cantidad-decimal' });
post('repetida invoices cantidad 2.5 texto', INVOICES, bigInvoice('2.5', '30.19'), { key: 'sondeo-cantidad-decimal' });
post('repetida invoices cuerpo distinto', INVOICES, bigInvoice('5', '60.38'), { key: 'sondeo-repetida' });
post('repetida invoices cuerpo inválido', INVOICES, {}, { key: 'sondeo-repetida' });
post('repetida clave de factura en nota de crédito', CREDITS, credit(), { key: 'sondeo-repetida' });
post('repetida clave de factura en nota de débito', DEBITS, debit(), { key: 'sondeo-repetida' });
sameKey('repetida credit-notes mismo cuerpo', CREDITS, credit(), credit(), 'sondeo-repetida-nc');
post('repetida credit-notes cuerpo distinto', CREDITS, credit({ reason: 'Otro motivo' }), { key: 'sondeo-repetida-nc' });
sameKey('repetida debit-notes mismo cuerpo', DEBITS, debit(), debit(), 'sondeo-repetida-nd');
post('repetida debit-notes cuerpo distinto', DEBITS, debit({ reasons: [reason({ reason: 'Otro motivo' })] }), { key: 'sondeo-repetida-nd' });
post('repetida clave de nota de crédito en factura', INVOICES, invoice(), { key: 'sondeo-repetida-nc' });
post('repetida ok POST /invoices', INVOICES, invoice(), { key: 'sondeo-ok-factura' });
post('repetida ok POST /credit-notes', CREDITS, credit({ lines: [creditLine({ quantity: '0.5' })] }), { key: 'sondeo-ok-nc' });
post('repetida de un fallo 422', INVOICES, invoice({ payments: [payment({ amount: '1.00' })] }), { key: 'sondeo-fallo' });
post('repetida de un fallo 422 corregido', INVOICES, invoice(), { key: 'sondeo-fallo' });

cases.splice(afterOk, 0, ...cases.splice(repeatStart));

// Consulta de /documents.
const pages = {
  letras: 'page=abc', negativo: 'page=-1', decimal: 'page=1.5', espacio: 'page=%202', mas: 'page=%2B2', hex: 'page=0x10',
  vacio: 'page=', repetido: 'page=1&page=2', tope: 'page=100000', fuera: 'page=100001', enorme: 'page=99999999999',
  sizeCero: 'size=0', sizeUno: 'size=1', sizeTope: 'size=100', sizeFuera: 'size=101', sizeVacio: 'size=', sizeLetras: 'size=x',
  paginaDos: 'page=1&size=2', paginaVacia: 'page=50',
};
for (const [kind, query] of Object.entries(pages)) get(`documents ${kind}`, DOCUMENTS, query);
const types = {
  factura: 'documentType=01', notaDeCredito: 'documentType=04', notaDeDebito: 'documentType=05', retencion: 'documentType=07', uno: 'documentType=1',
  remision: 'documentType=06', dos: 'documentType=02', letras: 'documentType=ab', vacio: 'documentType=', repetido: 'documentType=01&documentType=04',
  conEspacios: 'documentType=%2001', minuscula: 'documentType=a', tresDigitos: 'documentType=001', facturaPagina: 'documentType=01&page=0&size=2',
  paginaNegativaYTipoDesconocido: 'page=-1&documentType=02', tipoDesconocidoYPaginaNegativa: 'documentType=02&page=-1',
  sizeFueraYTipoDesconocido: 'size=101&documentType=ab', paginaLetrasYTipoDesconocido: 'page=abc&documentType=ab',
};
for (const [kind, query] of Object.entries(types)) get(`documents documentType ${kind}`, DOCUMENTS, query);
get('documents sin credenciales', DOCUMENTS, undefined, { auth: 'none' });
get('documents id sin credenciales', `${DOCUMENTS}/{invoiceId}`, undefined, { auth: 'none' });

// GET /documents/{id}.
for (const [kind, id] of Object.entries({
  malformado: 'x', desconocido: UNKNOWN, mayusculas: '{invoiceIdUpper}', sinGuiones: '{invoiceIdNoDash}', corto: '1-2-3-4-5',
  espacios: '%20{invoiceId}%20', cero: '0', largo: '1-2-3-4-1234567890abcd',
}))
  get(`GET /documents/{id} ${kind}`, `${DOCUMENTS}/${id}`);
get('GET /documents/{id}/xml', `${DOCUMENTS}/{invoiceId}/xml`);
for (const method of ['PUT', 'DELETE', 'PATCH', 'POST']) other(method, `${DOCUMENTS}/{invoiceId}`);
for (const [path, methods] of Object.entries({ [INVOICES]: ['GET', 'PUT', 'DELETE', 'OPTIONS'], [CREDITS]: ['GET', 'OPTIONS'], [DEBITS]: ['GET', 'OPTIONS'], [DOCUMENTS]: ['POST', 'DELETE', 'OPTIONS'] }))
  for (const method of methods) other(method, path);

// Los comprobantes que quedaron, tras todos los casos.
get('al final GET /documents', DOCUMENTS, 'size=100');
get('al final GET /documents facturas', DOCUMENTS, 'documentType=01&size=100');
get('al final GET /documents notas de crédito', DOCUMENTS, 'documentType=04&size=100');
get('al final GET /documents notas de débito', DOCUMENTS, 'documentType=05&size=100');
get('al final GET /documents/{id} factura de la plataforma', `${DOCUMENTS}/{invoiceId}`);
get('al final GET /documents/{id} factura emitida', `${DOCUMENTS}/{okInvoiceId}`);

const names = new Set();
for (const probe of cases) {
  if (names.has(probe.name)) throw new Error(`caso repetido: ${probe.name}`);
  names.add(probe.name);
}
writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`);
console.log(cases.length);
