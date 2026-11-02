import { randomInt } from 'node:crypto';
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
