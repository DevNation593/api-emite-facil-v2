import { startStack, type StackHandle } from '../../support/containers.js';
import { bearer, newOwner, randomRuc, taxpayerJson } from '../../support/scenario.js';
import { startTestApp, type TestApp } from '../../support/test-app.js';

// Traducción de TaxpayerFiscalDataIT: datos del emisor que van al XML como leyendas.
const TAXPAYERS = '/api/v1/taxpayers';
let stack: StackHandle;
let testApp: TestApp;
let owner: string;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
}, 300_000);
afterAll(async () => {
  await testApp?.close();
  await stack?.stop();
});
beforeEach(async () => {
  owner = (await newOwner(testApp.http)).token;
});

const post = (extra: Record<string, unknown>) =>
  testApp.http
    .post(TAXPAYERS)
    .set('Authorization', bearer(owner))
    .send({ ...taxpayerJson(randomRuc()), ...extra });

it('los valores por omisión', async () => {
  const res = await post({}).expect(201);
  expect(res.body).toMatchObject({
    accountingRequired: false,
    specialTaxpayerCode: null,
    withholdingAgentCode: null,
    rimpeRegime: 'NONE',
  });
});

it('acepta y devuelve los datos fiscales', async () => {
  const res = await post({
    accountingRequired: true,
    specialTaxpayerCode: '5368',
    withholdingAgentCode: '1',
    rimpeRegime: 'EMPRENDEDOR',
  }).expect(201);
  expect(res.body).toMatchObject({
    accountingRequired: true,
    specialTaxpayerCode: '5368',
    withholdingAgentCode: '1',
    rimpeRegime: 'EMPRENDEDOR',
  });
  const read = await testApp.http
    .get(`${TAXPAYERS}/${(res.body as { id: string }).id}`)
    .set('Authorization', bearer(owner))
    .expect(200);
  expect(read.body).toMatchObject({ specialTaxpayerCode: '5368', rimpeRegime: 'EMPRENDEDOR' });
  const longest = await post({ withholdingAgentCode: '12345678' }).expect(201);
  expect(longest.body.withholdingAgentCode).toBe('12345678');
});

it('RIMPE negocio popular se rechaza hasta que el XSD admita su leyenda', async () => {
  const res = await post({ rimpeRegime: 'NEGOCIO_POPULAR' }).expect(422);
  expect(res.body).toMatchObject({
    errorCode: 'RIMPE_REGIME_UNSUPPORTED',
    detail: 'Todavía no se pueden emitir comprobantes de contribuyentes RIMPE negocio popular',
  });
});

it('el ambiente de producción no se elige al dar de alta', async () => {
  const res = await post({ defaultEnvironment: '2' }).expect(422);
  expect(res.body).toMatchObject({
    errorCode: 'PRODUCTION_NOT_ENABLED',
    detail: 'Un emisor se da de alta en el ambiente de pruebas; el paso a producción se activa después',
  });
});

it.each([
  ['specialTaxpayerCode', '12'],
  ['specialTaxpayerCode', '12-34'],
  ['specialTaxpayerCode', '12345678901234'],
  ['withholdingAgentCode', '01'],
  ['withholdingAgentCode', '12A'],
  ['withholdingAgentCode', '123456789'],
])('rechaza %s %j', async (field, value) => {
  const res = await post({ [field]: value }).expect(400);
  expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  expect((res.body.errors as Array<{ field: string }>).map((e) => e.field)).toContain(field);
});

it('un régimen RIMPE desconocido es JSON no legible', async () => {
  const res = await post({ rimpeRegime: 'OTRO' }).expect(400);
  expect(res.body.errorCode).toBe('MALFORMED_REQUEST');
});
