import type { DbHandle } from '../../support/db-handle.js';
import { startDb } from '../../support/db-handle.js';
import {
  expectConstraintViolation,
  insertDocument,
  newCustomer,
  newEmissionPoint,
  newEstablishment,
  newProduct,
  newScenario,
  newTaxpayer,
  newTenant,
  randomAccessKey,
} from '../../support/billing-data.js';

// Traducción de BillingSchemaIT: unicidad de secuencial, clave de acceso e idempotencia, y pertenencia
// al tenant, sostenidas en la base.
let handle: DbHandle;
beforeAll(async () => {
  handle = await startDb();
}, 300_000);
afterAll(async () => {
  await handle?.stop();
});

describe('esquema de facturación', () => {
  it('la identificación del cliente es única por empresa', async () => {
    const { pgc } = handle;
    const tenant = await newTenant(pgc);
    await newCustomer(pgc, tenant, '05', '1712345678');
    await expectConstraintViolation(
      newCustomer(pgc, tenant, '05', '1712345678'),
    );
    await newCustomer(pgc, await newTenant(pgc), '05', '1712345678');
  });

  it('el SKU del producto es único por empresa', async () => {
    const { pgc } = handle;
    const tenant = await newTenant(pgc);
    await newProduct(pgc, tenant, 'SKU-1', '4');
    await expectConstraintViolation(newProduct(pgc, tenant, 'SKU-1', '4'));
    await expectConstraintViolation(newProduct(pgc, tenant, 'SKU-2', '9'));
  });

  it('un comprobante no puede apuntar al cliente de otra empresa', async () => {
    const { pgc } = handle;
    const a = await newScenario(pgc);
    const foreignCustomer = await newCustomer(
      pgc,
      await newTenant(pgc),
      '05',
      '1712345678',
    );
    await expectConstraintViolation(
      insertDocument(pgc, { ...a, customer: foreignCustomer }, 1),
    );
  });

  it('el secuencial y la clave de acceso son únicos', async () => {
    const { pgc } = handle;
    const a = await newScenario(pgc);
    const key = randomAccessKey();
    await insertDocument(pgc, a, 1, { accessKey: key });
    await expectConstraintViolation(insertDocument(pgc, a, 1));
    await expectConstraintViolation(
      insertDocument(pgc, a, 2, { accessKey: key }),
    );
    await insertDocument(pgc, a, 2);
  });

  it('la clave de idempotencia es única por empresa', async () => {
    const { pgc } = handle;
    const tenant = await newTenant(pgc);
    const insert = (t: string, hash: string) =>
      pgc.query(
        'INSERT INTO idempotency_records (tenant_id, idempotency_key, request_hash) VALUES ($1, $2, $3)',
        [t, 'k-1', hash.repeat(64)],
      );
    await insert(tenant, 'a');
    await expectConstraintViolation(insert(tenant, 'b'));
    await insert(await newTenant(pgc), 'a');
  });

  it('el establecimiento y el punto de emisión se crean con los ayudantes', async () => {
    const { pgc } = handle;
    const tenant = await newTenant(pgc);
    const establishment = await newEstablishment(
      pgc,
      tenant,
      await newTaxpayer(pgc, tenant),
      '001',
    );
    expect(await newEmissionPoint(pgc, tenant, establishment, '001')).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });
});
