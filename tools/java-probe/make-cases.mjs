#!/usr/bin/env node
// Escribe cases/e2.json, los casos de sondeo de E2. Uso: node tools/java-probe/make-cases.mjs
// Los casos se generan para no escribir a mano variantes casi iguales; el JSON es lo que se versiona.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('./cases/e2.json', import.meta.url));
const cases = [];
const add = (name, method, path, extra = {}) => cases.push({ name, method, path, auth: 'owner', ...extra });
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
let ruc = 0;
const nextRuc = () => `09900${String(++ruc).padStart(5, '0')}001`;
const taxpayer = (over) => ({ ruc: nextRuc(), legalName: 'Emisor', headOfficeAddress: 'Calle 1', defaultEnvironment: '1', ...over });

// Cuerpos: tipos equivocados donde Java no espera texto.
const odd = {
  texto: 'si', textoTrue: 'true', textoTRUE: 'TRUE', uno: 1, cero: 0, decimal: 1.5, objeto: { a: 1 }, array: [1], nulo: null,
  vacio: '', textoFalse: 'false', textoFALSE: 'FALSE', dos: 2, negativo: -1, textoUno: '1', textoCero: '0', espacios: ' true ',
};
for (const [k, v] of Object.entries(odd)) add(`taxpayer accountingRequired ${k}`, 'POST', '/api/v1/taxpayers', { body: taxpayer({ accountingRequired: v }) });
const rimpe = {
  minusculas: 'emprendedor', mayusculas: 'EMPRENDEDOR', desconocido: 'OTRO', vacio: '', numero: 1, nulo: null,
  negocioPopular: 'NEGOCIO_POPULAR', objeto: {}, cero: 0, indiceFuera: 3, negativo: -1, textoNumero: '1', mixto: 'Emprendedor',
  espacios: ' EMPRENDEDOR ', booleano: true, decimal: 1.5,
};
for (const [k, v] of Object.entries(rimpe))
  add(`taxpayer rimpeRegime ${k}`, 'POST', '/api/v1/taxpayers', { body: taxpayer({ rimpeRegime: v }) });
add('taxpayer ruc numérico', 'POST', '/api/v1/taxpayers', { body: taxpayer({ ruc: 990099999001 }) });
add('taxpayer defaultEnvironment numérico', 'POST', '/api/v1/taxpayers', { body: taxpayer({ defaultEnvironment: 1 }) });
add('taxpayer defaultEnvironment 2', 'POST', '/api/v1/taxpayers', { body: taxpayer({ defaultEnvironment: '2' }) });
add('taxpayer sin campos', 'POST', '/api/v1/taxpayers', { body: {} });
add('taxpayer ruc repetido', 'POST', '/api/v1/taxpayers', { body: taxpayer({ ruc: '1790012345001' }) });
add('taxpayer códigos inválidos', 'POST', '/api/v1/taxpayers', { body: taxpayer({ specialTaxpayerCode: 'ab', withholdingAgentCode: '0123' }) });
add('taxpayer tenantId en el cuerpo', 'POST', '/api/v1/taxpayers', { body: taxpayer({ tenantId: UNKNOWN }) });

const uuidOdd = {
  malformado: 'x', numero: 123, booleano: true, objeto: { a: 1 }, array: [], nulo: null, vacio: '',
  mayusculas: '{establishmentIdUpper}', sinGuiones: '{establishmentIdNoDash}', desconocido: UNKNOWN,
  llaves: '{{establishmentId}}', espacios: ' {establishmentId} ', corto: '1-2-3-4-5',
};
for (const [k, v] of Object.entries(uuidOdd)) add(`emission point establishmentId ${k}`, 'POST', '/api/v1/emission-points', { body: { establishmentId: v, code: '009' } });
add('emission point code numérico', 'POST', '/api/v1/emission-points', { body: { establishmentId: '{establishmentId}', code: 2 } });
add('emission point repetido', 'POST', '/api/v1/emission-points', { body: { establishmentId: '{establishmentId}', code: '001' } });
add('establishment code numérico', 'POST', '/api/v1/taxpayers/{taxpayerId}/establishments', { body: { code: 2, address: 'Calle' } });
add('establishment repetido', 'POST', '/api/v1/taxpayers/{taxpayerId}/establishments', { body: { code: '001', address: 'Calle' } });

// Secuencial: un Integer en Jackson.
const ints = {
  texto: '5', decimal: 5.7, decimalCero: 6.0, booleano: true, letras: 'abc', grande: 2147483648, hex: '0x10',
  cero: 0, maximo: 999999999, tope: 1000000000, negativo: -1, nulo: null, array: [], objeto: {}, textoEspacios: ' 7 ',
  vacio: '', textoMas: '+8', textoDecimal: '9.5', textoExponente: '1e2', textoGrande: '2147483648', textoNegativo: '-3',
  decimalNegativo: -0.5, decimalGrande: 2147483648.5, textoInterno: '1 0',
};
for (const [k, v] of Object.entries(ints)) add(`sequence nextValue ${k}`, 'PUT', '/api/v1/emission-points/{emissionPointId}/sequence', { body: { environment: '1', documentType: '01', nextValue: v } });
add('sequence nextValue exponente', 'PUT', '/api/v1/emission-points/{emissionPointId}/sequence', { rawBody: '{"environment":"1","documentType":"01","nextValue":1e3}' });
add('sequence nextValue decimal con cero escrito', 'PUT', '/api/v1/emission-points/{emissionPointId}/sequence', { rawBody: '{"environment":"1","documentType":"01","nextValue":6.0}' });
add('sequence environment numérico', 'PUT', '/api/v1/emission-points/{emissionPointId}/sequence', { body: { environment: 2, documentType: '01', nextValue: 3 } });
add('sequence documentType 04', 'PUT', '/api/v1/emission-points/{emissionPointId}/sequence', { body: { environment: '1', documentType: '04', nextValue: 3 } });
add('sequence punto desconocido', 'PUT', `/api/v1/emission-points/${UNKNOWN}/sequence`, { body: { environment: '1', documentType: '01', nextValue: 3 } });

// Certificados: Base64 y tipos.
const p12 = {
  saltoDeLinea: 'QUJD\nREVG', crlf: 'QUJD\r\n', espacio: ' QUJD', sinRelleno: 'QUI', urlSafe: 'Pz8-Pz8_', vacio: '',
  unCaracter: 'Q', cincoCaracteres: 'QUJDR', basura: 'QUJD', relleno: 'QQ==', rellenoDeMas: 'QQ===', asterisco: 'QU*D',
};
for (const [k, v] of Object.entries(p12)) add(`certificate p12 ${k}`, 'POST', '/api/v1/certificates', { body: { taxpayerId: '{taxpayerId}', p12: v, password: 'x' } });
add('certificate taxpayerId malformado', 'POST', '/api/v1/certificates', { body: { taxpayerId: 'x', p12: 'QUJD', password: 'x' } });
add('certificate taxpayerId desconocido', 'POST', '/api/v1/certificates', { body: { taxpayerId: UNKNOWN, p12: 'QUJD', password: 'x' } });
add('certificate password numérica', 'POST', '/api/v1/certificates', { body: { taxpayerId: '{taxpayerId}', p12: 'QUJD', password: 123 } });
add('certificate sin campos', 'POST', '/api/v1/certificates', { body: {} });

// Clientes y productos.
add('customer idType numérico', 'POST', '/api/v1/customers', { body: { idType: 5, idNumber: '1712345678', name: 'X' } });
add('customer tipo desconocido', 'POST', '/api/v1/customers', { body: { idType: '99', idNumber: '1712345678', name: 'X' } });
add('customer consumidor final como RUC', 'POST', '/api/v1/customers', { body: { idType: '04', idNumber: '9999999999999', name: 'X' } });
add('customer correo inválido', 'POST', '/api/v1/customers', { body: { idType: '05', idNumber: '1700000001', name: 'X', email: 'no-es' } });
add('customer repetido', 'POST', '/api/v1/customers', { body: { idType: '05', idNumber: '1712345678', name: 'X' } });
add('customer en blanco', 'POST', '/api/v1/customers', { body: { idType: '05', idNumber: '1700000002', name: '  Nombre  ', email: ' ', address: '', phone: '  ' } });
const prices = { numero: 10.5, siete: '1.1234567', negativo: '-1', exponente: '1e3', coma: '1,5', trece: '1234567890123', cero: '0', espacios: ' 1 ' };
for (const [k, v] of Object.entries(prices)) add(`product unitPrice ${k}`, 'POST', '/api/v1/products', { body: { sku: `P-${k}`, name: 'Producto', unitPrice: v, ivaRateCode: '4' } });
add('product ivaRateCode numérico', 'POST', '/api/v1/products', { body: { sku: 'P-iva', name: 'Producto', unitPrice: '1', ivaRateCode: 4 } });
add('product tarifa desconocida', 'POST', '/api/v1/products', { body: { sku: 'P-iva9', name: 'Producto', unitPrice: '1', ivaRateCode: '9' } });
add('product sku inválido', 'POST', '/api/v1/products', { body: { sku: 'con espacio', name: 'Producto', unitPrice: '1', ivaRateCode: '4' } });
add('product sku repetido', 'POST', '/api/v1/products', { body: { sku: 'SKU-SONDEO', name: 'Producto', unitPrice: '1', ivaRateCode: '4' } });

// Parámetros de consulta.
const pages = {
  letras: 'page=abc', negativo: 'page=-1', decimal: 'page=1.5', espacio: 'page=%202', mas: 'page=%2B2', hex: 'page=0x10',
  almohadilla: 'page=%2310', vacio: 'page=', repetido: 'page=1&page=2', tope: 'page=100000', fuera: 'page=100001',
  enorme: 'page=99999999999', sizeCero: 'size=0', sizeTope: 'size=100', sizeFuera: 'size=101', sizeVacio: 'size=',
  espacioInterno: 'page=1%200', ceroIzquierda: 'page=010', hexMayusculas: 'page=0X1', hexNegativo: 'page=-0x1', soloHex: 'page=0x',
  tabulador: 'page=%092', espacioFinal: 'page=2%20', masMenos: 'page=%2B-1', nbsp: 'page=%C2%A02',
};
for (const [k, q] of Object.entries(pages)) add(`customers ${k}`, 'GET', '/api/v1/customers', { query: q });
const terms = {
  porcentaje: 'q=%25', guion: 'q=_', barra: 'q=%5C', repetido: 'q=Cliente&q=Sondeo', cien: `q=${'a'.repeat(100)}`,
  cientoUno: `q=${'a'.repeat(101)}`, control: 'q=a%01', espacios: 'q=%20%20', mayusculas: 'q=CLIENTE', identificacion: 'q=1712',
  tilde: 'q=%C3%B1',
};
for (const [k, q] of Object.entries(terms)) add(`customers q ${k}`, 'GET', '/api/v1/customers', { query: q });
for (const [k, q] of Object.entries({ letras: 'page=abc', sizeFuera: 'size=101', porcentaje: 'q=%25', sku: 'q=sku-son', repetido: 'page=0&page=1' }))
  add(`products ${k}`, 'GET', '/api/v1/products', { query: q });
const ids = {
  ausente: undefined, vacio: 'establishmentId=', malformado: 'establishmentId=x', mayusculas: 'establishmentId={establishmentIdUpper}',
  espacios: 'establishmentId=%20{establishmentId}%20', corto: 'establishmentId=1-2-3-4-5',
  repetido: 'establishmentId={establishmentId}&establishmentId=x', desconocido: `establishmentId=${UNKNOWN}`, valido: 'establishmentId={establishmentId}',
};
for (const [k, q] of Object.entries(ids)) add(`emission points ${k}`, 'GET', '/api/v1/emission-points', q === undefined ? {} : { query: q });
for (const [k, q] of Object.entries({ ausente: undefined, malformado: 'taxpayerId=x', desconocido: `taxpayerId=${UNKNOWN}`, valido: 'taxpayerId={taxpayerId}' }))
  add(`certificates ${k}`, 'GET', '/api/v1/certificates', q === undefined ? {} : { query: q });

// Rutas.
for (const path of ['/api/v1/taxpayers/x', '/api/v1/customers/x', '/api/v1/products/x', '/api/v1/taxpayers/x/establishments', `/api/v1/taxpayers/${UNKNOWN}`, `/api/v1/customers/${UNKNOWN}`, `/api/v1/taxpayers/${UNKNOWN}/establishments`])
  add(`GET ${path}`, 'GET', path);
for (const [k, id] of Object.entries({ corto: '1-2-3-4-5', espacios: '%20{customerId}%20', signo: '+1-2-3-4-5', largo: '1-2-3-4-1234567890abcd', base64: 'AAAAAAAAAAAAAAAAAAAAAA==' }))
  add(`GET /customers/id ${k}`, 'GET', `/api/v1/customers/${id}`);
add('PUT /customers/x', 'PUT', '/api/v1/customers/x', { body: { idType: '05', idNumber: '1712345678', name: 'X' } });
add('DELETE /products/x', 'DELETE', '/api/v1/products/x');
add('PUT /emission-points/x/sequence', 'PUT', '/api/v1/emission-points/x/sequence', { body: { environment: '1', documentType: '01', nextValue: 3 } });
add('PUT /customers sin id', 'PUT', '/api/v1/customers', { body: {} });
add('DELETE /taxpayers/{id}', 'DELETE', '/api/v1/taxpayers/{taxpayerId}');
add('PATCH taxpayer sin cuerpo', 'PATCH', '/api/v1/taxpayers/{taxpayerId}', { rawBody: '' });
add('PATCH taxpayer phone numérico', 'PATCH', '/api/v1/taxpayers/{taxpayerId}', { body: { phone: 22223333 } });
add('PATCH taxpayer phone objeto', 'PATCH', '/api/v1/taxpayers/{taxpayerId}', { body: { phone: {} } });
add('PATCH taxpayer phone en blanco', 'PATCH', '/api/v1/taxpayers/{taxpayerId}', { body: { phone: '  ' } });
add('OPTIONS /customers', 'OPTIONS', '/api/v1/customers');
add('OPTIONS /taxpayers/{id}', 'OPTIONS', '/api/v1/taxpayers/{taxpayerId}');
add('OPTIONS /catalogs/tax-rates', 'OPTIONS', '/api/v1/catalogs/tax-rates');
add('DELETE /catalogs/tax-rates', 'DELETE', '/api/v1/catalogs/tax-rates');
add('HEAD /catalogs/tax-rates', 'HEAD', '/api/v1/catalogs/tax-rates');
add('catalogs sin credenciales', 'GET', '/api/v1/catalogs/tax-rates', { auth: 'none' });

// Respuestas 2xx: forma, orden de propiedades y nulos.
for (const path of ['/api/v1/catalogs/identification-types', '/api/v1/catalogs/payment-methods', '/api/v1/catalogs/tax-rates', '/api/v1/taxpayers', '/api/v1/taxpayers/{taxpayerId}', '/api/v1/taxpayers/{taxpayerId}/establishments', '/api/v1/customers', '/api/v1/customers/{customerId}', '/api/v1/products', '/api/v1/products/{productId}'])
  add(`ok GET ${path}`, 'GET', path);
add('ok PATCH taxpayer phone', 'PATCH', '/api/v1/taxpayers/{taxpayerId}', { body: { phone: ' 022 345 678 ' } });
add('ok POST establishment', 'POST', '/api/v1/taxpayers/{taxpayerId}/establishments', { body: { code: '002', address: '  Sucursal  ' } });
add('ok POST taxpayer completo', 'POST', '/api/v1/taxpayers', {
  body: taxpayer({ tradeName: ' Comercial ', phone: '', accountingRequired: true, specialTaxpayerCode: 'ABC123', withholdingAgentCode: '12345', rimpeRegime: 'EMPRENDEDOR' }),
});
add('ok PUT customer', 'PUT', '/api/v1/customers/{customerId}', { body: { idType: '05', idNumber: '1712345678', name: 'Cliente Editado', email: 'a@b.ec', address: 'Dir', phone: '099' } });
add('ok PUT product', 'PUT', '/api/v1/products/{productId}', { body: { sku: 'SKU-SONDEO', name: 'Producto Editado', unitPrice: '0', ivaRateCode: '0' } });
add('ok PUT sequence', 'PUT', '/api/v1/emission-points/{emissionPointId}/sequence', { body: { environment: '2', documentType: '01', nextValue: 42 } });
add('ok DELETE customer', 'DELETE', '/api/v1/customers/{customerId}');
add('ok GET customer borrado', 'GET', '/api/v1/customers/{customerId}');
add('ok DELETE product', 'DELETE', '/api/v1/products/{productId}');
add('ok DELETE product otra vez', 'DELETE', '/api/v1/products/{productId}');
writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`);
console.log(cases.length);
