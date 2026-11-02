import pg from 'pg';
import type { Kysely } from 'kysely';
import { AuditLog } from '../../../src/compliance/audit-log.js';
import { DATABASE } from '../../../src/database/database.module.js';
import type { DB } from '../../../src/database/schema.js';
import { TenantAccess } from '../../../src/tenancy/tenant-access.js';
import { startStack, type StackHandle } from '../../support/containers.js';
import { registerAndLogin, startTestApp, type TestApp } from '../../support/test-app.js';

/** Gestión de las API keys de la empresa (ApiKeyApiIT y parte de ApiKeyAuthenticationIT). */
const BASE = '/api/v1/api-keys';
const TENANT_HEADER = 'X-Tenant-Id';
const KEY_HEADER = 'X-Api-Key';
const SHAPE = /^efk_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/;
const UNAUTHENTICATED = 'Se requiere un token de acceso válido';

let stack: StackHandle;
let testApp: TestApp;
let db: pg.Client;

beforeAll(async () => {
  stack = await startStack();
  testApp = await startTestApp(stack);
  db = new pg.Client({ connectionString: stack.databaseUrl });
  await db.connect();
}, 300_000);
afterAll(async () => {
  await db?.end();
  await testApp?.close();
  await stack?.stop();
});

const http = () => testApp.http;
const bearer = (token: string) => `Bearer ${token}`;

let owner: string;
let ownerId: string;
let ownerEmail: string;
let tenant: string;

async function createTenant(token: string): Promise<string> {
  const res = await http()
    .post('/api/v1/tenants')
    .set('Authorization', bearer(token))
    .send({ name: 'Empresa' })
    .expect(201);
  return (res.body as { id: string }).id;
}

beforeEach(async () => {
  const user = await registerAndLogin(http());
  owner = user.accessToken;
  ownerId = user.userId;
  ownerEmail = user.email;
  tenant = await createTenant(owner);
});

/** Una persona nueva con ese rol en la empresa de la prueba. */
async function memberToken(role: string): Promise<string> {
  const user = await registerAndLogin(http());
  await db.query('INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)', [
    user.userId,
    tenant,
    role,
  ]);
  return user.accessToken;
}

const create = (token: string, name: string) =>
  http()
    .post(BASE)
    .set('Authorization', bearer(token))
    .set(TENANT_HEADER, tenant)
    .set('Content-Type', 'application/json')
    // El cuerpo se escribe a mano, como en Java: así un escape JSON llega tal cual.
    .send(`{"name":"${name}"}`);
const list = (token: string) =>
  http().get(BASE).set('Authorization', bearer(token)).set(TENANT_HEADER, tenant);
const revoke = (token: string, id: string) =>
  http().delete(`${BASE}/${id}`).set('Authorization', bearer(token)).set(TENANT_HEADER, tenant);

interface Created {
  id: string;
  name: string;
  publicId: string;
  key: string;
  createdAt: string;
}

async function created(name: string): Promise<Created> {
  return (await create(owner, name).expect(201)).body as Created;
}

const active = async () =>
  Number(
    (
      await db.query<{ n: string }>(
        'SELECT count(*) AS n FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL',
        [tenant],
      )
    ).rows[0]!.n,
  );

describe('ApiKeyApiIT', () => {
  it('el propietario crea, lista y revoca', async () => {
    const res = await create(owner, 'ERP Contable').expect(201);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const body = res.body as Created;
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'id', 'key', 'name', 'publicId']);
    expect(body.key).toMatch(SHAPE);
    expect(body.key.substring(4, 16)).toBe(body.publicId);
    expect(body.name).toBe('ERP Contable');
    expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
    const secret = body.key.substring(17);

    const listed = await list(owner).expect(200);
    expect(listed.body).toEqual([
      {
        id: body.id,
        name: 'ERP Contable',
        publicId: body.publicId,
        createdBy: ownerEmail,
        createdAt: body.createdAt,
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    expect(listed.text).not.toContain(secret);

    await revoke(owner, body.id).expect(204);
    const after = await list(owner).expect(200);
    expect(after.body[0].revokedAt).toEqual(expect.any(String));
    await revoke(owner, body.id).expect(204);
  });

  it('un ADMIN también gestiona las keys', async () => {
    await create(await memberToken('ADMIN'), 'Desde admin').expect(201);
  });

  it('BILLER y AUDITOR no gestionan las keys', async () => {
    const { id } = await created('ERP Contable');
    for (const role of ['BILLER', 'AUDITOR']) {
      const token = await memberToken(role);
      for (const call of [() => create(token, 'Otra'), () => list(token), () => revoke(token, id)]) {
        const res = await call().expect(403);
        expect(res.body).toMatchObject({
          errorCode: 'ROLE_FORBIDDEN',
          detail: 'El rol no permite esta operación',
        });
      }
    }
    expect(await active()).toBe(1);
  });

  it('la décima key es la última', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 10; i++) ids.push((await created(`Key ${i}`)).id);
    const res = await create(owner, 'Key 11').expect(409);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.body).toMatchObject({
      errorCode: 'API_KEY_LIMIT',
      detail: 'La empresa ya tiene el máximo de API keys activas; revoque alguna',
    });
    await revoke(owner, ids[0]!).expect(204);
    await create(owner, 'Key 11').expect(201);
  });

  it('altas simultáneas respetan el tope', async () => {
    for (let i = 1; i <= 9; i++) await created(`Key ${i}`);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_v, i) => create(owner, `Concurrente ${i}`)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409 && r.body.errorCode === 'API_KEY_LIMIT'),
    ).toHaveLength(19);
    expect(await active()).toBe(10);
  });

  it('los nombres activos no se repiten, sin distinguir mayúsculas', async () => {
    const { id } = await created('ERP Contable');
    for (const name of ['ERP Contable', 'erp contable']) {
      const res = await create(owner, name).expect(409);
      expect(res.body).toMatchObject({
        errorCode: 'API_KEY_NAME_TAKEN',
        detail: 'Ya hay una API key activa con ese nombre',
      });
    }
    await revoke(owner, id).expect(204);
    await create(owner, 'ERP Contable').expect(201);
    // El choque de nombre deshace la transacción: no queda ni la key ni su auditoría.
    const audit = await db.query(
      `SELECT count(*) AS n FROM audit_events WHERE tenant_id = $1 AND action = 'API_KEY_CREATED'`,
      [tenant],
    );
    expect(Number(audit.rows[0].n)).toBe(2);
  });

  it('el nombre se valida', async () => {
    // "\\u0007" llega al servidor como el escape JSON de un carácter de control.
    for (const bad of ['', '   ', 'a'.repeat(81), 'ERP\\u0007']) {
      const res = await create(owner, bad).expect(400);
      expect(res.body.errorCode).toBe('VALIDATION_FAILED');
    }
    // Espacios Unicode que @NotBlank de Java no ve: al recortar, el nombre queda vacío o largo.
    for (const bad of ['　', '　 　', `  ${'a'.repeat(81)}　`]) {
      const res = await create(owner, bad).expect(400);
      expect(res.body.errorCode).toBe('VALIDATION_FAILED');
      expect(res.body.errors[0].field).toBe('name');
    }
    const longOne = await create(owner, `  ${'a'.repeat(81)}　`).expect(400);
    expect(longOne.body.errors).toEqual([
      {
        field: 'name',
        message: 'debe tener entre 1 y 80 caracteres sin contar los espacios de los extremos',
      },
    ]);
    const trimmed = await create(owner, '  ERP  ').expect(201);
    expect(trimmed.body.name).toBe('ERP');
    expect((await list(owner).expect(200)).body[0].name).toBe('ERP');
    // El largo se mide ya recortado y por puntos de código.
    const eighty = 'b'.repeat(80);
    const ok = await create(owner, `  ${eighty}　 `).expect(201);
    expect(ok.body.name).toBe(eighty);
    const emoji = '😀'.repeat(80);
    expect((await create(owner, emoji).expect(201)).body.name).toBe(emoji);
    expect(await active()).toBe(3);
  });

  it('un nombre ausente, nulo o que no es texto es 400', async () => {
    // Un número sí vale: Jackson lo convierte en texto.
    for (const body of ['{}', '{"name":null}', '{"name":["ERP"]}', '{"name":{}}']) {
      const res = await http()
        .post(BASE)
        .set('Authorization', bearer(owner))
        .set(TENANT_HEADER, tenant)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(res.status).toBe(400);
    }
    expect(await active()).toBe(0);
  });

  it('las keys de otra empresa no existen', async () => {
    const { id } = await created('ERP Contable');
    const stranger = (await registerAndLogin(http())).accessToken;
    const other = await createTenant(stranger);
    const res = await http()
      .delete(`${BASE}/${id}`)
      .set('Authorization', bearer(stranger))
      .set(TENANT_HEADER, other)
      .expect(404);
    expect(res.body).toMatchObject({ errorCode: 'API_KEY_NOT_FOUND', detail: 'La API key no existe' });
    const theirs = await http()
      .get(BASE)
      .set('Authorization', bearer(stranger))
      .set(TENANT_HEADER, other)
      .expect(200);
    expect(theirs.body).toEqual([]);
    expect(await active()).toBe(1);
  });

  it('una key inexistente es 404 y un id mal formado es 400', async () => {
    const missing = await revoke(owner, '00000000-0000-4000-8000-000000000000').expect(404);
    expect(missing.body.errorCode).toBe('API_KEY_NOT_FOUND');
    const malformed = await revoke(owner, 'no-es-un-uuid').expect(400);
    expect(malformed.body.errorCode).toBe('MALFORMED_REQUEST');
  });

  it('crear y revocar se auditan, sin la key ni su hash', async () => {
    const body = await created('ERP Contable');
    const secret = body.key.substring(17);
    const hash = (
      await db.query<{ h: string }>('SELECT secret_hash AS h FROM api_keys WHERE id = $1', [body.id])
    ).rows[0]!.h;
    await revoke(owner, body.id).expect(204);
    // El segundo DELETE no cambia nada, así que no vuelve a auditar.
    await revoke(owner, body.id).expect(204);

    for (const action of ['API_KEY_CREATED', 'API_KEY_REVOKED']) {
      const rows = await db.query(
        `SELECT entity_type, entity_id, actor_id, api_key_id, metadata, metadata::text AS raw
           FROM audit_events WHERE tenant_id = $1 AND action = $2`,
        [tenant, action],
      );
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      expect(row.entity_type).toBe('API_KEY');
      expect(row.entity_id).toBe(body.id);
      expect(row.actor_id).toBe(ownerId);
      expect(row.api_key_id).toBeNull();
      expect(row.metadata).toEqual({ name: 'ERP Contable' });
      expect(row.raw).not.toContain(secret);
      expect(row.raw).not.toContain(hash);
      expect(row.raw).not.toContain(body.publicId);
    }
    const revokedBy = await db.query('SELECT revoked_by FROM api_keys WHERE id = $1', [body.id]);
    expect(revokedBy.rows[0].revoked_by).toBe(ownerId);
  });

  it('la lista trae primero las activas y luego la más nueva', async () => {
    const old = await created('Antigua');
    await revoke(owner, old.id).expect(204);
    await created('Primera activa');
    await created('Segunda activa');
    const at = async (name: string, interval: string) =>
      db.query(
        `UPDATE api_keys SET created_at = now() - CAST($2 AS interval) WHERE tenant_id = $1 AND name = $3`,
        [tenant, interval, name],
      );
    await at('Antigua', '3 hours');
    await at('Primera activa', '2 hours');
    await at('Segunda activa', '1 hour');
    const res = await list(owner).expect(200);
    expect((res.body as Array<{ name: string }>).map((k) => k.name)).toEqual([
      'Segunda activa',
      'Primera activa',
      'Antigua',
    ]);
  });
});

describe('ApiKeyAuthenticationIT con keys creadas por la API', () => {
  const currentTenant = (value: string) =>
    http().get('/api/v1/tenants/current').set(KEY_HEADER, value);

  it('una key revocada deja de servir en la petición siguiente', async () => {
    const { id, key } = await created('ERP Contable');
    const ok = await currentTenant(key).expect(200);
    expect(ok.body).toMatchObject({ id: tenant, role: 'BILLER' });
    await revoke(owner, id).expect(204);
    const res = await currentTenant(key).expect(401);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.body).toMatchObject({ errorCode: 'UNAUTHENTICATED', detail: UNAUTHENTICATED });
  });

  it('last_used_at se escribe como mucho una vez por minuto', async () => {
    const { id, key } = await created('ERP Contable');
    const lastUsedAt = async () =>
      (
        await db.query<{ t: Date | null }>('SELECT last_used_at AS t FROM api_keys WHERE id = $1', [id])
      ).rows[0]!.t;
    expect(await lastUsedAt()).toBeNull();
    await currentTenant(key).expect(200);
    const first = await lastUsedAt();
    expect(first).not.toBeNull();
    await currentTenant(key).expect(200);
    expect(await lastUsedAt()).toEqual(first);

    await db.query(`UPDATE api_keys SET last_used_at = now() - interval '2 minutes' WHERE id = $1`, [id]);
    const old = await lastUsedAt();
    await currentTenant(key).expect(200);
    expect((await lastUsedAt())!.getTime()).toBeGreaterThan(old!.getTime());
    // La lista muestra el último uso.
    const listed = await list(owner).expect(200);
    expect(listed.body[0].lastUsedAt).toEqual(expect.any(String));
  });

  it('una key no gestiona keys', async () => {
    const { key } = await created('ERP Contable');
    const calls = [
      () => http().post(BASE).set(KEY_HEADER, key).send({ name: 'Otra' }),
      () => http().get(BASE).set(KEY_HEADER, key),
    ];
    for (const call of calls) {
      const res = await call().expect(403);
      expect(res.body.errorCode).toBe('ROLE_FORBIDDEN');
    }
    expect(await active()).toBe(1);
  });

  // auditNamesTheKeyAndItsCreator recorre facturas y clientes, que llegan en E2. Aquí se comprueba
  // la parte de esta etapa: la empresa activa que deja la key y lo que AuditLog escribe con ella.
  it('la auditoría con una key nombra la key y a quien la creó', async () => {
    const { id, key } = await created('ERP Contable');
    await currentTenant(key).expect(200);
    const kysely = testApp.app.get<Kysely<DB>>(DATABASE);
    const audit = testApp.app.get(AuditLog);
    const viaKey = new TenantAccess(ownerId, tenant, 'BILLER', id);
    await kysely.transaction().execute((trx) =>
      audit.recordFor(trx, viaKey, 'PRUEBA_CON_KEY', 'API_KEY', id, {}),
    );
    const rows = await db.query(
      `SELECT actor_id, api_key_id FROM audit_events WHERE tenant_id = $1 AND action = 'PRUEBA_CON_KEY'`,
      [tenant],
    );
    expect(rows.rows).toEqual([{ actor_id: ownerId, api_key_id: id }]);
  });
});
