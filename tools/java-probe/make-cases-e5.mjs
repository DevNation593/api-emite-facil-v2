#!/usr/bin/env node
// Escribe cases/e5.json, los casos de sondeo de E5: la descarga de artefactos, las entregas de un comprobante,
// las cabeceras de seguridad y los cuerpos que Java no lee. Uso: node tools/java-probe/make-cases-e5.mjs
// Parten del escenario con `hooks.seedArtifacts` (ver `runScenario`): `{archivedDocumentId}` con artefactos y
// entregas, `{bareDocumentId}` sin nada, `{mailedDocumentId}` de un cliente con correo y `{limitDocumentId}`
// con el máximo de entregas, además de lo de E4.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SEEDED_ARTIFACTS } from './probe.mjs';

const out = fileURLToPath(new URL('./cases/e5.json', import.meta.url));
const cases = [];
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const DOCUMENTS = '/api/v1/documents';

const SECURITY = [
  'cache-control',
  'pragma',
  'expires',
  'x-content-type-options',
  'x-frame-options',
  'x-xss-protection',
  'strict-transport-security',
];
const DOWNLOAD = ['etag', 'content-disposition', 'content-length', 'accept-ranges', 'vary', 'last-modified', ...SECURITY];

const add = (name, method, path, extra = {}) => cases.push({ name, method, path, auth: 'owner', ...extra });
const artifact = (name, id, kind, extra = {}) =>
  add(`artefacto ${name}`, 'GET', `${DOCUMENTS}/${id}/artifacts/${kind}`, extra);
const deliveries = (name, id, extra = {}) => add(`entregas ${name}`, 'GET', `${DOCUMENTS}/${id}/deliveries`, extra);
const request = (name, id, extra = {}) => add(`entrega ${name}`, 'POST', `${DOCUMENTS}/${id}/deliveries`, extra);

const sha = (kind) =>
  createHash('sha256')
    .update(SEEDED_ARTIFACTS.find((item) => item.kind === kind).content, 'utf8')
    .digest('hex');
const RIDE = sha('RIDE_PDF');

// Cabeceras de seguridad, en cualquier respuesta.
add('cabeceras de una lista', 'GET', DOCUMENTS, { query: 'size=1&documentType=06', checkHeaders: SECURITY });
add('cabeceras de un 404', 'GET', `${DOCUMENTS}/${UNKNOWN}`, { checkHeaders: SECURITY });
add('cabeceras de un 401', 'GET', DOCUMENTS, { auth: 'none', checkHeaders: SECURITY });
add('cabeceras de una ruta que no existe', 'GET', '/otra', { auth: 'none', checkHeaders: SECURITY });
add('cabeceras de un 405', 'PUT', DOCUMENTS, { checkHeaders: SECURITY });
add('cabeceras de OPTIONS', 'OPTIONS', DOCUMENTS, { checkHeaders: SECURITY });
add('cabeceras de health', 'GET', '/actuator/health', { auth: 'none', checkHeaders: SECURITY });
add('cabeceras de un ingreso rechazado', 'POST', '/api/v1/auth/login', {
  auth: 'none',
  headers: { 'x-forwarded-for': '198.51.100.9' },
  body: { email: 'nadie@example.test', password: 'una contraseña larga' },
  checkHeaders: SECURITY,
});
add('cabeceras de un cuerpo ilegible', 'POST', '/api/v1/customers', {
  rawBody: '{',
  headers: { 'content-type': 'application/json' },
  checkHeaders: SECURITY,
});
add('cabeceras tras un proxy con TLS', 'GET', `${DOCUMENTS}/${UNKNOWN}`, {
  headers: { 'x-forwarded-proto': 'https' },
  checkHeaders: SECURITY,
});

// Descarga.
for (const kind of ['xml-unsigned', 'xml-signed', 'sri-authorization', 'xml-authorized', 'ride'])
  artifact(kind, '{archivedDocumentId}', kind, { checkHeaders: DOWNLOAD });
artifact('con rol AUDITOR', '{archivedDocumentId}', 'ride', { auth: 'auditor', checkHeaders: DOWNLOAD });
artifact('con rol BILLER', '{archivedDocumentId}', 'ride', { auth: 'biller' });
artifact('con id en mayúsculas', '{archivedDocumentIdUpper}', 'ride');
artifact('con id sin guiones', '{archivedDocumentIdNoDash}', 'ride');
artifact('HEAD', '{archivedDocumentId}', 'ride', { method: 'HEAD', checkHeaders: DOWNLOAD });
artifact('con parámetros que se ignoran', '{archivedDocumentId}', 'ride', { query: 'download=1' });

// Condicionales, rangos y negociación.
const conditional = (name, headers, kind = 'ride', extra = {}) =>
  artifact(name, '{archivedDocumentId}', kind, { headers, checkHeaders: DOWNLOAD, ...extra });
conditional('con If-None-Match igual', { 'if-none-match': `"${RIDE}"` });
conditional('con If-None-Match débil', { 'if-none-match': `W/"${RIDE}"` });
conditional('con If-None-Match comodín', { 'if-none-match': '*' });
conditional('con If-None-Match distinto', { 'if-none-match': '"otro"' });
conditional('con If-None-Match en lista', { 'if-none-match': `"otro", "${RIDE}"` });
conditional('con If-None-Match en lista sin espacios', { 'if-none-match': `"otro","${RIDE}"` });
conditional('con If-None-Match repetido', { 'if-none-match': ['"otro"', `"${RIDE}"`] });
conditional('con If-None-Match sin comillas', { 'if-none-match': RIDE });
conditional('con If-None-Match vacío', { 'if-none-match': '' });
conditional('con If-None-Match igual y HEAD', { 'if-none-match': `"${RIDE}"` }, 'ride', { method: 'HEAD' });
conditional('con If-None-Match igual y If-Match distinto', { 'if-none-match': `"${RIDE}"`, 'if-match': '"otro"' });
conditional('con If-Match igual', { 'if-match': `"${RIDE}"` });
conditional('con If-Match comodín', { 'if-match': '*' });
conditional('con If-Match distinto', { 'if-match': '"otro"' });
conditional('con If-Match débil', { 'if-match': `W/"${RIDE}"` });
conditional('con If-Modified-Since', { 'if-modified-since': 'Wed, 21 Oct 2099 07:28:00 GMT' });
conditional('con If-Unmodified-Since', { 'if-unmodified-since': 'Wed, 21 Oct 2009 07:28:00 GMT' });
conditional('con Range', { range: 'bytes=0-3' });
conditional('con Range fuera del contenido', { range: 'bytes=1000-' });
conditional('con Accept application/json', { accept: 'application/json' });
conditional('con Accept text/html', { accept: 'text/html' });
conditional('con Accept application/pdf;q=0', { accept: 'application/pdf;q=0' });
conditional('con Accept mal formado', { accept: 'esto no es un tipo' });
conditional('XML con Accept application/json', { accept: 'application/json' }, 'xml-signed');
artifact('inexistente con If-None-Match comodín', '{bareDocumentId}', 'ride', { headers: { 'if-none-match': '*' } });

// Errores.
for (const [name, kind] of [
  ['desconocido', 'pdf'],
  ['en mayúsculas', 'RIDE'],
  ['con espacio', 'ride%20'],
  ['con el nombre interno', 'RIDE_PDF'],
  ['con extensión', 'ride.pdf'],
  ['vacío', ''],
  ['con barra final', 'ride/'],
])
  artifact(`de un tipo ${name}`, '{archivedDocumentId}', kind);
artifact('de un tipo desconocido con Accept XML', '{archivedDocumentId}', 'pdf', { headers: { accept: 'application/xml' } });
artifact('con id mal formado', 'no-es-un-uuid', 'ride');
artifact('con id mal formado y tipo desconocido', 'no-es-un-uuid', 'pdf');
artifact('de un id desconocido', UNKNOWN, 'ride');
artifact('de un id y un tipo desconocidos', UNKNOWN, 'pdf');
artifact('aún no generado', '{bareDocumentId}', 'ride');
artifact('de otra empresa', '{otherInvoiceId}', 'ride');
artifact('con otra empresa activa', '{archivedDocumentId}', 'ride', { headers: { 'x-tenant-id': '{otherTenantId}' } });
artifact('sin membresía', '{archivedDocumentId}', 'ride', { auth: 'stranger' });
artifact('sin autenticación', '{archivedDocumentId}', 'ride', { auth: 'none' });
for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
  artifact(method, '{archivedDocumentId}', 'ride', { method });
add('artefactos sin tipo', 'GET', `${DOCUMENTS}/{archivedDocumentId}/artifacts`);

// Consulta de entregas.
deliveries('sembradas', '{archivedDocumentId}');
deliveries('sembradas con rol AUDITOR', '{archivedDocumentId}', { auth: 'auditor' });
deliveries('sembradas con rol BILLER', '{archivedDocumentId}', { auth: 'biller' });
deliveries('sin ninguna', '{bareDocumentId}');
deliveries('de un comprobante reservado', '{retryDocumentId}');
deliveries('con id en mayúsculas', '{archivedDocumentIdUpper}');
deliveries('con parámetros que se ignoran', '{archivedDocumentId}', { query: 'page=1&size=1' });
deliveries('con id mal formado', 'no-es-un-uuid');
deliveries('de un id desconocido', UNKNOWN);
deliveries('de otra empresa', '{otherInvoiceId}');
deliveries('sin membresía', '{archivedDocumentId}', { auth: 'stranger' });
deliveries('sin autenticación', '{archivedDocumentId}', { auth: 'none' });
deliveries('con Accept text/html', '{archivedDocumentId}', { headers: { accept: 'text/html' } });
add('entregas con barra final', 'GET', `${DOCUMENTS}/{archivedDocumentId}/deliveries/`);
for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'])
  add(`entregas ${method}`, method, `${DOCUMENTS}/{archivedDocumentId}/deliveries`);

// Petición de una entrega: el cuerpo. Tres comprobantes que nunca llegan a 10 entregas.
const onBare = (name, extra) => request(name, '{bareDocumentId}', extra);
const onMailed = (name, extra) => request(name, '{mailedDocumentId}', extra);
const json = (rawBody) => ({ rawBody, headers: { 'content-type': 'application/json' } });
const email = (value) => ({ body: { email: value } });

// Sin dirección en el comprobante: cada cuerpo que no da una termina en 422 y no crea nada.
onBare('sin cuerpo ni correo del cliente', {});
onBare('con {} y sin correo del cliente', { body: {} });
onBare('con null y sin correo del cliente', json('null'));
onBare('con email null', email(null));
onBare('con email vacío', email(''));
onBare('con email de espacios', email('  \t'));
onBare('con email de espacio duro', email(' '));
onBare('con email de espacio ideográfico', email('　'));
onBare('con propiedad desconocida', { body: { correo: 'a@b.test' } });
onBare('con Email en otra caja', { body: { Email: 'a@b.test' } });
onBare('con Content-Type JSON y sin cuerpo', { headers: { 'content-type': 'application/json' } });
onBare('con Content-Type de texto y sin cuerpo', { headers: { 'content-type': 'text/plain' } });
onBare('con cuerpo de espacios', json('   '));

// Direcciones y cuerpos que no valen: 400 sin crear nada.
for (const [name, value] of [
  ['sin arroba', 'no-es-un-correo'],
  ['con salto de línea', 'a@b.test\r\nBcc: x@evil.test'],
  ['con nombre', 'Nombre <a@b.test>'],
  ['en lista', 'a@b.test, c@d.test'],
  ['en grupo', 'grupo:a@b.test,c@d.test;'],
  ['demasiado larga', `${'x'.repeat(250)}@b.test`],
  ['con dos arrobas', 'a@b@c.test'],
  ['sin dominio', 'a@'],
  ['sin nombre', '@b.test'],
  ['con punto final', 'a@b.test.'],
  ['con dos puntos seguidos', 'a..b@c.test'],
  ['con espacio', 'a b@c.test'],
  ['con guion bajo en el dominio', 'a@b_c.test'],
  ['con barra invertida', 'a\\b@c.test'],
  ['con NUL', 'a\u0000@b.test'],
])
  onMailed(`con una dirección ${name}`, email(value));
onMailed('con email objeto', email({ a: 1 }));
onMailed('con email lista', email(['a@b.test']));
onMailed('con email número', email(5));
onMailed('con email booleano', email(true));
onMailed('con una lista', json('[]'));
onMailed('con un texto', json('"a@b.test"'));
onMailed('con un texto vacío', json('""'));
onMailed('con un número', json('5'));
onMailed('con JSON ilegible', json('{'));
onMailed('con email repetido y el último no válido', json('{"email":"a@b.test","email":"no"}'));
onMailed('con cuerpo de texto', { rawBody: 'a@b.test', headers: { 'content-type': 'text/plain' } });
onMailed('con cuerpo XML', { rawBody: '<email>a@b.test</email>', headers: { 'content-type': 'application/xml' } });
onMailed('con cuerpo y Content-Type vacío', { rawBody: '{}', headers: { 'content-type': '' } });

// Las que se aceptan.
onMailed('sin cuerpo', {});
onMailed('con {}', { body: {} });
onMailed('con null', json('null'));
onMailed('a otra dirección', email('otra.persona+facturas@mi-empresa.com.ec'));
onMailed('a una dirección con espacios alrededor', email('  rodeada@example.test\t'));
onMailed('a un dominio sin punto', email('a@localhost'));
onMailed('con rol BILLER', { auth: 'biller', ...email('biller@example.test') });
onBare('a una dirección dada', email('nueva@example.test'));
onBare('a un dominio literal', email('a@[127.0.0.1]'));
onBare('con vnd.api+json', { rawBody: '{"email":"vnd@example.test"}', headers: { 'content-type': 'application/vnd.api+json' } });
onBare('con Accept text/html', { ...email('html@example.test'), headers: { accept: 'text/html' } });
deliveries('tras pedirlas', '{mailedDocumentId}');
deliveries('tras pedirlas sin correo del cliente', '{bareDocumentId}');

// Estados, roles y pertenencia.
request('en el tope', '{limitDocumentId}', {});
request('en el tope con una dirección no válida', '{limitDocumentId}', email('no'));
request('de un comprobante reservado', '{retryDocumentId}', email('a@b.test'));
request('de un comprobante reservado con una dirección no válida', '{retryDocumentId}', email('no'));
request('de un comprobante devuelto', '{returnedDocumentId}', {});
request('con rol AUDITOR', '{mailedDocumentId}', { auth: 'auditor' });
request('con rol AUDITOR y JSON ilegible', '{mailedDocumentId}', { auth: 'auditor', ...json('{') });
request('con rol AUDITOR sobre un id desconocido', UNKNOWN, { auth: 'auditor' });
request('con id mal formado', 'no-es-un-uuid', {});
request('con id mal formado y JSON ilegible', 'no-es-un-uuid', json('{'));
request('de un id desconocido', UNKNOWN, {});
request('de un id desconocido con una dirección no válida', UNKNOWN, email('no'));
request('de otra empresa', '{otherInvoiceId}', {});
request('sin membresía', '{mailedDocumentId}', { auth: 'stranger' });
request('sin autenticación', '{mailedDocumentId}', { auth: 'none' });

// Cuerpos que Java no lee: GET y DELETE no tienen @RequestBody. node:http no declara el cuerpo de un GET o un
// DELETE si no se le da su longitud.
const unread = { rawBody: '{', headers: { 'content-type': 'application/json', 'content-length': '1' } };
add('documento con cuerpo ilegible', 'GET', `${DOCUMENTS}/{bareDocumentId}`, unread);
deliveries('con cuerpo ilegible', '{limitDocumentId}', unread);
artifact('con cuerpo ilegible', '{archivedDocumentId}', 'ride', unread);
add('cliente sin borrar, con cuerpo ilegible', 'DELETE', `/api/v1/customers/${UNKNOWN}`, unread);
add('producto sin borrar, con cuerpo ilegible', 'DELETE', `/api/v1/products/${UNKNOWN}`, unread);
add('API key sin borrar, con cuerpo ilegible', 'DELETE', `/api/v1/api-keys/${UNKNOWN}`, unread);
add('OPTIONS con cuerpo ilegible', 'OPTIONS', DOCUMENTS, unread);
add('ruta inexistente con cuerpo ilegible', 'POST', '/api/v1/no-existe', unread);
add('método no admitido con cuerpo ilegible', 'PUT', DOCUMENTS, unread);
add('cliente borrado con cuerpo de texto', 'DELETE', '/api/v1/customers/{customerId}', {
  rawBody: 'hola',
  headers: { 'content-type': 'text/plain', 'content-length': '4' },
});

// El cuerpo se lee al final: antes van la ruta, el acceso y la empresa.
add('cliente con id mal formado y JSON ilegible', 'PUT', '/api/v1/customers/no-es-un-uuid', json('{'));
add('cliente sin membresía y JSON ilegible', 'POST', '/api/v1/customers', { auth: 'stranger', ...json('{') });
add('cliente con empresa mal formada y JSON ilegible', 'POST', '/api/v1/customers', {
  rawBody: '{',
  headers: { 'content-type': 'application/json', 'x-tenant-id': 'no-uuid' },
});
add('cliente con rol AUDITOR y JSON ilegible', 'POST', '/api/v1/customers', { auth: 'auditor', ...json('{') });
add('factura sin Idempotency-Key y JSON ilegible', 'POST', '/api/v1/invoices', json('{'));
request('sin membresía y JSON ilegible', '{mailedDocumentId}', { auth: 'stranger', ...json('{') });
request('con id mal formado y cuerpo de texto', 'no-es-un-uuid', {
  rawBody: 'hola',
  headers: { 'content-type': 'text/plain' },
});

writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`);
console.log(`[make-cases-e5] ${cases.length} casos en ${out}`);
