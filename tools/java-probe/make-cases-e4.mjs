#!/usr/bin/env node
// Escribe cases/e4.json, los casos de sondeo de E4: `POST /documents/{id}/retry` y
// `GET /documents/{id}/sri-attempts`. Uso: node tools/java-probe/make-cases-e4.mjs
// Parten del escenario con `hooks.seedAttempts` (ver `runScenario`): `{invoiceId}` AUTHORIZED con dos
// intentos sembrados, `{retryDocumentId}` RESERVED sin intentos, `{returnedDocumentId}` RETURNED,
// `{notAuthorizedDocumentId}` NOT_AUTHORIZED y `{otherInvoiceId}` de otra empresa.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('./cases/e4.json', import.meta.url));
const cases = [];
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const DOCUMENTS = '/api/v1/documents';

const add = (name, method, path, extra = {}) => cases.push({ name, method, path, auth: 'owner', ...extra });
const retry = (name, id, extra = {}) => add(`retry ${name}`, 'POST', `${DOCUMENTS}/${id}/retry`, extra);
const attempts = (name, id, extra = {}) => add(`sri-attempts ${name}`, 'GET', `${DOCUMENTS}/${id}/sri-attempts`, extra);
const document = (name, id, extra = {}) => add(`documento ${name}`, 'GET', `${DOCUMENTS}/${id}`, extra);

// Antes de reintentar: lo sembrado, tal como queda.
attempts('con intentos sembrados', '{invoiceId}');
attempts('sin intentos', '{retryDocumentId}');
attempts('de un comprobante devuelto sin intentos', '{returnedDocumentId}');
document('autorizado con intentos', '{invoiceId}');
document('reservado para reintentar', '{retryDocumentId}');
document('devuelto', '{returnedDocumentId}');
document('no autorizado', '{notAuthorizedDocumentId}');

// Reintento: estados.
retry('sobre RESERVED', '{retryDocumentId}');
retry('sobre RESERVED otra vez', '{retryDocumentId}');
retry('sobre RESERVED con el id en mayúsculas', '{retryDocumentIdUpper}');
retry('sobre RESERVED con el id sin guiones', '{retryDocumentIdNoDash}');
retry('sobre RETURNED', '{returnedDocumentId}');
retry('sobre AUTHORIZED', '{invoiceId}');
retry('sobre NOT_AUTHORIZED', '{notAuthorizedDocumentId}');
document('reservado tras reintentar', '{retryDocumentId}');
document('devuelto tras reintentar', '{returnedDocumentId}');
attempts('sin intentos tras reintentar', '{retryDocumentId}');

// Reintento: identificador.
retry('con id mal formado', 'no-es-un-uuid');
retry('con id casi uuid', '00000000-0000-4000-8000-00000000000');
retry('con id desconocido', UNKNOWN);
retry('con comprobante de otra empresa', '{otherInvoiceId}');
retry('con id mal formado y rol AUDITOR', 'no-es-un-uuid', { auth: 'auditor' });

// Reintento: roles y autenticación.
retry('con rol AUDITOR sobre RESERVED', '{retryDocumentId}', { auth: 'auditor' });
retry('con rol AUDITOR sobre RETURNED', '{returnedDocumentId}', { auth: 'auditor' });
retry('con rol AUDITOR sobre un id desconocido', UNKNOWN, { auth: 'auditor' });
retry('con rol AUDITOR sobre otra empresa', '{otherInvoiceId}', { auth: 'auditor' });
retry('con rol BILLER sobre RESERVED', '{retryDocumentId}', { auth: 'biller' });
retry('con rol BILLER sobre RETURNED', '{returnedDocumentId}', { auth: 'biller' });
retry('con rol BILLER sobre un id desconocido', UNKNOWN, { auth: 'biller' });
retry('con rol BILLER sobre otra empresa', '{otherInvoiceId}', { auth: 'biller' });
retry('sin membresía en la empresa', '{retryDocumentId}', { auth: 'stranger' });
retry('sin autenticación', '{retryDocumentId}', { auth: 'none' });
retry('con token inválido', '{retryDocumentId}', { auth: 'none', headers: { authorization: 'Bearer abc' } });
retry('con x-tenant-id mal formado', '{retryDocumentId}', { headers: { 'x-tenant-id': 'no-uuid' } });
retry('con x-tenant-id de otra empresa', '{retryDocumentId}', { headers: { 'x-tenant-id': '{otherTenantId}' } });

// Reintento: cuerpo y tipo de contenido (no se lee).
retry('con cuerpo JSON', '{retryDocumentId}', { body: { reason: 'otra vez' } });
retry('con cuerpo JSON mal formado', '{retryDocumentId}', { rawBody: '{', headers: { 'content-type': 'application/json' } });
retry('con cuerpo de texto', '{retryDocumentId}', { rawBody: 'hola', headers: { 'content-type': 'text/plain' } });
retry('con cuerpo XML', '{retryDocumentId}', { rawBody: '<a/>', headers: { 'content-type': 'application/xml' } });
retry('con Content-Type raro', '{retryDocumentId}', { rawBody: '{}', headers: { 'content-type': 'application/x-raro; charset=nope' } });
retry('con Content-Type vacío', '{retryDocumentId}', { rawBody: '{}', headers: { 'content-type': '' } });
retry('con cuerpo en un estado no reintentable', '{returnedDocumentId}', { body: { reason: 'otra vez' } });
add('retry con barra final', 'POST', `${DOCUMENTS}/{retryDocumentId}/retry/`);

// Reintento: métodos.
for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
  add(`retry ${method}`, method, `${DOCUMENTS}/{retryDocumentId}/retry`);

// Intentos.
attempts('con intentos sembrados otra vez', '{invoiceId}');
attempts('con id en mayúsculas', '{invoiceIdUpper}');
attempts('con id sin guiones', '{invoiceIdNoDash}');
add('sri-attempts con parámetros que se ignoran', 'GET', `${DOCUMENTS}/{invoiceId}/sri-attempts`, {
  query: 'page=1&size=1&sort=startedAt',
});
add('sri-attempts con barra final', 'GET', `${DOCUMENTS}/{invoiceId}/sri-attempts/`);
attempts('con id mal formado', 'no-es-un-uuid');
attempts('con id desconocido', UNKNOWN);
attempts('de otra empresa', '{otherInvoiceId}');
attempts('con rol AUDITOR', '{invoiceId}', { auth: 'auditor' });
attempts('con rol BILLER', '{invoiceId}', { auth: 'biller' });
attempts('con rol AUDITOR sobre otra empresa', '{otherInvoiceId}', { auth: 'auditor' });
attempts('sin membresía en la empresa', '{invoiceId}', { auth: 'stranger' });
attempts('sin autenticación', '{invoiceId}', { auth: 'none' });
attempts('con id mal formado y sin autenticación', 'no-es-un-uuid', { auth: 'none' });
attempts('con x-tenant-id de otra empresa', '{invoiceId}', { headers: { 'x-tenant-id': '{otherTenantId}' } });
for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
  add(`sri-attempts ${method}`, method, `${DOCUMENTS}/{invoiceId}/sri-attempts`);
add('sri-attempts POST con cuerpo', 'POST', `${DOCUMENTS}/{invoiceId}/sri-attempts`, { body: {} });

// La vista del comprobante con intentos no cambia, ni expone nada de ellos.
document('autorizado con intentos otra vez', '{invoiceId}');
document('de otra empresa', '{otherInvoiceId}');
document('de otra empresa con rol AUDITOR', '{otherInvoiceId}', { auth: 'auditor' });
document('con intentos y rol AUDITOR', '{invoiceId}', { auth: 'auditor' });
add('documentos lista', 'GET', DOCUMENTS, { query: 'size=100' });

writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`);
console.log(`[make-cases-e4] ${cases.length} casos en ${out}`);
