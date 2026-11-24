import { readDocumentEvent, RejectedEvent } from '../../../src/orchestration/document-event.js';

// DocumentEvent.read de Java: un mensaje ilegible o incompleto se rechaza sin volver a la cola.
const json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
const EVENT = '0b7c1f9e-9a3e-4c64-8c1e-2f5d6b7a8c90';
const TENANT = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const DOCUMENT = '9f8e7d6c-5b4a-4f3e-9d2c-1b0a9f8e7d6c';

it('lee los cuatro campos', () => {
  expect(readDocumentEvent(json({ eventId: EVENT, tenantId: TENANT, documentId: DOCUMENT, eventType: 'DOCUMENT_DUE' }))).toEqual({
    eventId: EVENT,
    tenantId: TENANT,
    documentId: DOCUMENT,
    eventType: 'DOCUMENT_DUE',
  });
});

it('los ids salen en minúsculas, como UUID.toString de Java', () => {
  const event = readDocumentEvent(
    json({ eventId: EVENT.toUpperCase(), tenantId: TENANT.toUpperCase(), documentId: DOCUMENT.toUpperCase(), eventType: 'X' }),
  );
  expect(event).toMatchObject({ eventId: EVENT, tenantId: TENANT, documentId: DOCUMENT });
});

it('sin eventId ni eventType se acepta, como Java (quedan nulos), y los campos de más se ignoran', () => {
  expect(readDocumentEvent(json({ tenantId: TENANT, documentId: DOCUMENT, otro: 1 }))).toEqual({
    eventId: null,
    tenantId: TENANT,
    documentId: DOCUMENT,
    eventType: null,
  });
});

it.each([
  ['no es JSON', Buffer.from('no es json')],
  ['vacío', Buffer.alloc(0)],
  ['un array', json([TENANT, DOCUMENT])],
  ['nulo', json(null)],
  ['sin tenantId', json({ eventId: EVENT, documentId: DOCUMENT })],
  ['sin documentId', json({ eventId: EVENT, tenantId: TENANT })],
  ['tenantId nulo', json({ tenantId: null, documentId: DOCUMENT })],
  ['documentId que no es UUID', json({ tenantId: TENANT, documentId: 'abc' })],
  ['tenantId numérico', json({ tenantId: 5, documentId: DOCUMENT })],
  ['eventType que no es texto', json({ tenantId: TENANT, documentId: DOCUMENT, eventType: {} })],
  ['UTF-8 inválido', Buffer.from([0x7b, 0xff, 0x7d])],
])('%s se rechaza', (_name, body) => {
  expect(() => readDocumentEvent(body)).toThrow(RejectedEvent);
});
