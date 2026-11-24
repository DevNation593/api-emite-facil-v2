import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DocumentPipeline } from '../../../src/orchestration/document-pipeline.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import {
  accessKeyOf,
  bearer,
  billingScenario,
  invoiceJson,
  issueInvoice,
  memberToken,
  uploadTestCertificate,
  type BillingScenario,
} from '../../support/scenario.js';
import { errorMsg, msg, notAuthorized, returned } from '../../support/sri-soap-samples.js';
import { Reply, SriStub, sriTestEnv } from '../../support/sri-stub.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de sri/SriAttemptApiIT.java: consulta de los intentos ante el SRI y de los datos de autorización.
let stack: StackHandle;
let sri: SriStub;
let testApp: TestApp;
let db: pg.Client;
let pipeline: DocumentPipeline;

beforeAll(async () => {
  stack = await startStack();
  sri = await SriStub.start();
  testApp = await startTestApp(stack, sriTestEnv(sri));
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
  pipeline = testApp.app.get(DocumentPipeline);
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await sri?.close();
  await stack?.stop();
});

let s: BillingScenario;
let document: string;
let key: string;
beforeEach(async () => {
  s = await billingScenario(testApp.http, db);
  await uploadTestCertificate(testApp.http, s.owner, s.taxpayer);
  document = await issueInvoice(testApp.http, s.owner, invoiceJson(s, '2', '23.00'));
  key = await accessKeyOf(db, document);
});

const attempts = (token: string, id = document) =>
  testApp.http.get(`/api/v1/documents/${id}/sri-attempts`).set('Authorization', bearer(token));
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3}|\.\d{6}|\.\d{9})?Z$/;

it('attemptsAreListedNewestFirstWithTheirMessages', async () => {
  sri.onAuthorization(
    key,
    Reply.xml(notAuthorized(key, 'NO AUTORIZADO', msg('39', 'FIRMA INVALIDA', 'La firma no corresponde al emisor', 'ERROR'))),
  );
  await pipeline.advance(s.tenant, document);

  const res = await attempts(s.owner).expect(200);
  const list = res.body as Array<Record<string, unknown>>;
  expect(list).toHaveLength(2);
  expect(Object.keys(list[0]!)).toEqual([
    'id',
    'operation',
    'outcome',
    'sriStatus',
    'httpStatus',
    'startedAt',
    'completedAt',
    'messages',
  ]);
  expect(list[0]).toMatchObject({
    operation: 'AUTHORIZATION',
    outcome: 'NOT_AUTHORIZED',
    sriStatus: 'NO AUTORIZADO',
    httpStatus: 200,
    messages: [
      { identifier: '39', message: 'FIRMA INVALIDA', additionalInfo: 'La firma no corresponde al emisor', type: 'ERROR' },
    ],
  });
  expect(list[0]!.startedAt).toMatch(INSTANT);
  expect(list[0]!.completedAt).toMatch(INSTANT);
  expect(Object.keys((list[0]!.messages as object[])[0]!)).toEqual(['identifier', 'message', 'additionalInfo', 'type']);
  expect(list[1]).toMatchObject({ operation: 'RECEPTION', outcome: 'RECEIVED', sriStatus: 'RECIBIDA', messages: [] });
});

it('rawResponseIsNeverExposed', async () => {
  sri.onReception(key, Reply.xml(returned(key, errorMsg('35', 'DOCUMENTO INVÁLIDO'))));
  await pipeline.advance(s.tenant, document);

  const res = await attempts(s.owner).expect(200);

  expect((res.body as Array<{ outcome: string }>)[0]!.outcome).toBe('RETURNED');
  for (const hidden of ['response', 'Envelope', 'errorDetail']) expect(res.text).not.toContain(hidden);
});

it('documentWithoutAttemptsHasAnEmptyList', async () => {
  const res = await attempts(await memberToken(testApp.http, db, s.tenant, 'AUDITOR')).expect(200);
  expect(res.body).toEqual([]);
});

it('foreignDocumentIsNotFound', async () => {
  await pipeline.advance(s.tenant, document);
  const other = await billingScenario(testApp.http, db);

  const foreign = await attempts(other.owner).expect(404);
  const missing = await attempts(s.owner, randomUUID()).expect(404);
  // Un comprobante de otra empresa responde igual que uno inexistente.
  const comparable = (body: object) => ({ ...body, instance: null, correlationId: null });
  expect(comparable(foreign.body as object)).toEqual(comparable(missing.body as object));
});

it('documentShowsItsAuthorization', async () => {
  const before = await testApp.http.get(`/api/v1/documents/${document}`).set('Authorization', bearer(s.owner));
  expect(before.body).toMatchObject({ authorizationNumber: null, authorizedAt: null });

  await pipeline.advance(s.tenant, document);

  const after = await testApp.http.get(`/api/v1/documents/${document}`).set('Authorization', bearer(s.owner));
  expect(after.body).toMatchObject({
    state: 'AUTHORIZED',
    authorizationNumber: key,
    authorizedAt: '2012-03-05T21:57:34.997Z',
  });
});
