import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type request from 'supertest';
import { registerAndLogin } from './test-app.js';

/*
 * Ayudantes de las pruebas de E2, como los de AbstractIntegrationTest y TestData de Java: crean por
 * la API lo que cada prueba necesita y siembran por SQL lo que la API no ofrece (miembros con rol).
 */

type Http = ReturnType<typeof request>;

export const bearer = (token: string) => `Bearer ${token}`;

/** Un RUC al azar con el sufijo 001 del establecimiento principal (TestData.ruc). */
export function randomRuc(): string {
  return `${String(randomInt(1_000_000_000, 9_999_999_999)).padStart(10, '0')}001`;
}

export function taxpayerJson(ruc: string): Record<string, unknown> {
  return {
    ruc,
    legalName: 'Comercial Andina S.A.',
    tradeName: 'Andina',
    headOfficeAddress: 'Av. Amazonas N34-12, Quito',
    defaultEnvironment: '1',
  };
}

/** Una persona nueva con su empresa; devuelve su token y la empresa. */
export async function newOwner(http: Http): Promise<{ token: string; userId: string; tenant: string }> {
  const user = await registerAndLogin(http);
  const res = await http
    .post('/api/v1/tenants')
    .set('Authorization', bearer(user.accessToken))
    .send({ name: 'Empresa de prueba' })
    .expect(201);
  return { token: user.accessToken, userId: user.userId, tenant: (res.body as { id: string }).id };
}

/** Una persona nueva con ese rol en la empresa (memberToken de Java). */
export async function memberToken(http: Http, db: pg.Client, tenant: string, role: string): Promise<string> {
  const user = await registerAndLogin(http);
  await db.query('INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)', [
    user.userId,
    tenant,
    role,
  ]);
  return user.accessToken;
}

async function created(call: request.Test): Promise<string> {
  const res = await call.expect(201);
  return (res.body as { id: string }).id;
}

export function createTaxpayer(http: Http, token: string, ruc: string = randomRuc()): Promise<string> {
  return created(http.post('/api/v1/taxpayers').set('Authorization', bearer(token)).send(taxpayerJson(ruc)));
}

export function createEstablishment(http: Http, token: string, taxpayer: string, code: string): Promise<string> {
  return created(
    http
      .post(`/api/v1/taxpayers/${taxpayer}/establishments`)
      .set('Authorization', bearer(token))
      .send({ code, address: 'Av. 10 de Agosto, Quito' }),
  );
}

export function createEmissionPoint(http: Http, token: string, establishment: string, code: string): Promise<string> {
  return created(
    http
      .post('/api/v1/emission-points')
      .set('Authorization', bearer(token))
      .send({ establishmentId: establishment, code }),
  );
}

/** Lo que dos respuestas 404 deben tener igual (assertSameProblem de TenantIsolationIT). */
export function sameProblem(first: Record<string, unknown>, second: Record<string, unknown>): void {
  for (const field of ['errorCode', 'detail', 'title', 'status']) {
    if (first[field] !== second[field]) {
      throw new Error(`${field} distinto: ${String(first[field])} frente a ${String(second[field])}`);
    }
  }
  if (first.errorCode !== 'NOT_FOUND') throw new Error(`errorCode ${String(first.errorCode)}`);
}

export function customerJson(idType: string, idNumber: string, name: string): Record<string, unknown> {
  return {
    idType,
    idNumber,
    name,
    email: 'cliente@example.test',
    address: 'Av. República, Quito',
    phone: '022345678',
  };
}

export function createCustomer(http: Http, token: string, idType: string, idNumber: string): Promise<string> {
  return created(
    http.post('/api/v1/customers').set('Authorization', bearer(token)).send(customerJson(idType, idNumber, 'María Pérez')),
  );
}

export function productJson(sku: string, unitPrice: string, ivaRateCode: string): Record<string, unknown> {
  return { sku, name: 'Servicio de consultoría', unitPrice, ivaRateCode };
}

export function createProduct(
  http: Http,
  token: string,
  sku: string,
  unitPrice: string,
  ivaRateCode: string,
): Promise<string> {
  return created(
    http.post('/api/v1/products').set('Authorization', bearer(token)).send(productJson(sku, unitPrice, ivaRateCode)),
  );
}

/**
 * Empresa lista para facturar (BillingScenario de Java): emisor con establecimiento 001 y punto de
 * emisión 001, un cliente con cédula y un producto de 10.00 con IVA del 15 % (código 4).
 */
export interface BillingScenario {
  owner: string;
  tenant: string;
  taxpayer: string;
  ruc: string;
  establishment: string;
  point: string;
  customer: string;
  product: string;
}

/** newBillingScenario de AbstractIntegrationTest: todo se crea por la API. */
export async function billingScenario(http: Http, _db: pg.Client): Promise<BillingScenario> {
  const { token: owner, tenant } = await newOwner(http);
  const ruc = randomRuc();
  const taxpayer = await createTaxpayer(http, owner, ruc);
  const establishment = await createEstablishment(http, owner, taxpayer, '001');
  const point = await createEmissionPoint(http, owner, establishment, '001');
  const customer = await createCustomer(http, owner, '05', '1712345678');
  const product = await createProduct(http, owner, 'SRV-001', '10.00', '4');
  return { owner, tenant, taxpayer, ruc, establishment, point, customer, product };
}

/** Una línea de factura; el precio y el descuento solo van si se dan. */
export function invoiceLine(
  productId: string,
  quantity: string,
  unitPrice?: string,
  discount?: string,
): Record<string, unknown> {
  return {
    productId,
    quantity,
    ...(unitPrice === undefined ? {} : { unitPrice }),
    ...(discount === undefined ? {} : { discount }),
  };
}

/** Cuerpo de POST /invoices con esas líneas, al cliente dado y con un solo pago (forma 20) por el importe dado. */
export function invoiceBody(
  s: BillingScenario,
  customerId: string,
  lines: unknown[],
  paymentAmount: string,
): Record<string, unknown> {
  return {
    taxpayerId: s.taxpayer,
    establishmentCode: '001',
    emissionPointCode: '001',
    customerId,
    lines,
    payments: [{ methodCode: '20', amount: paymentAmount }],
  };
}

/** Cuerpo de POST /invoices con una línea del producto del escenario y un pago por el importe dado. */
export function invoiceJson(s: BillingScenario, quantity: string, paymentAmount: string): Record<string, unknown> {
  return invoiceBody(s, s.customer, [{ productId: s.product, quantity }], paymentAmount);
}

/** POST /invoices; un texto se envía tal cual, para conservar números como 2.50. */
export function invoiceRequest(http: Http, token: string, body: unknown, key?: string): request.Test {
  let call = http.post('/api/v1/invoices').set('Authorization', bearer(token));
  if (key !== undefined) call = call.set('Idempotency-Key', key);
  return typeof body === 'string' ? call.set('Content-Type', 'application/json').send(body) : call.send(body as object);
}

/** Emite una factura con una clave de idempotencia nueva (o la dada) y devuelve el id del documento. */
export async function issueInvoice(http: Http, token: string, body: unknown, key: string = randomUUID()): Promise<string> {
  const res = await invoiceRequest(http, token, body, key);
  if (res.status !== 202) throw new Error(`Se esperaba 202 y llegó ${res.status}: ${res.text}`);
  return (res.body as { id: string }).id;
}

/** Pone el comprobante en ese estado por SQL: en E3 no hay worker ni SRI que lo hagan avanzar. */
export async function setState(db: pg.Client, documentId: string, state: string): Promise<void> {
  await db.query('UPDATE fiscal_documents SET state = $1 WHERE id = $2', [state, documentId]);
}
