import type { Request } from 'express';
import type { Transaction } from 'kysely';
import { ApiException } from '../../../src/common/api-exception.js';
import { AuditLog } from '../../../src/compliance/audit-log.js';
import type { DB } from '../../../src/database/schema.js';
import {
  API_KEY_ROLE,
  canBill,
  canWrite,
  parseTenantHeader,
  ROLES,
  TenantAccess,
  tenantAccessOf,
  type Role,
} from '../../../src/tenancy/tenant-access.js';

const USER = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';

const person = (role: Role) => new TenantAccess(USER, TENANT, role, null);
const viaKey = () => new TenantAccess(USER, TENANT, API_KEY_ROLE, KEY);
const forbidden = (action: () => void) => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    expect(error).toMatchObject({
      status: 403,
      errorCode: 'ROLE_FORBIDDEN',
      detail: 'El rol no permite esta operación',
    });
    return;
  }
  throw new Error('debía responder 403');
};

describe('roles', () => {
  it('solo OWNER y ADMIN escriben; OWNER, ADMIN y BILLER facturan', () => {
    expect(ROLES.map((r) => [r, canWrite(r), canBill(r)])).toEqual([
      ['OWNER', true, true],
      ['ADMIN', true, true],
      ['BILLER', false, true],
      ['AUDITOR', false, false],
    ]);
  });

  it('una API key actúa siempre como BILLER', () => {
    expect(API_KEY_ROLE).toBe('BILLER');
  });
});

describe('TenantAccess', () => {
  it('viaApiKey depende de apiKeyId', () => {
    expect(person('OWNER').viaApiKey).toBe(false);
    expect(viaKey().viaApiKey).toBe(true);
  });

  it('requireWrite', () => {
    person('OWNER').requireWrite();
    person('ADMIN').requireWrite();
    forbidden(() => person('BILLER').requireWrite());
    forbidden(() => person('AUDITOR').requireWrite());
  });

  it('requireOwner: solo el propietario', () => {
    person('OWNER').requireOwner();
    for (const role of ['ADMIN', 'BILLER', 'AUDITOR'] as const) {
      forbidden(() => person(role).requireOwner());
    }
  });

  it('requireBilling', () => {
    for (const role of ['OWNER', 'ADMIN', 'BILLER'] as const) person(role).requireBilling();
    forbidden(() => person('AUDITOR').requireBilling());
  });

  it('requireProductCreation: una persona necesita escribir; una key, facturar', () => {
    person('OWNER').requireProductCreation();
    person('ADMIN').requireProductCreation();
    forbidden(() => person('BILLER').requireProductCreation());
    forbidden(() => person('AUDITOR').requireProductCreation());
    viaKey().requireProductCreation();
  });
});

describe('parseTenantHeader', () => {
  it('acepta el UUID con espacios alrededor y lo pasa a minúsculas', () => {
    expect(parseTenantHeader(`  ${TENANT.toUpperCase()}\t`)).toBe(TENANT);
  });

  it.each([
    'abc',
    '1-1-1-1-1',
    TENANT.replaceAll('-', ''),
    `${TENANT}0`,
    `{${TENANT}}`,
    TENANT.replace('2222', 'zzzz'),
    ' ' + TENANT,
  ])('rechaza %j', (value) => {
    expect(() => parseTenantHeader(value)).toThrow(
      expect.objectContaining({
        status: 400,
        errorCode: 'TENANT_HEADER_INVALID',
        detail: 'La cabecera X-Tenant-Id debe ser un UUID',
      }),
    );
  });
});

describe('tenantAccessOf', () => {
  it('si el guard no corrió falla cerrado, no devuelve nada', () => {
    expect(() => tenantAccessOf({} as Request)).toThrow(/TenantAccessGuard/);
  });
});

describe('AuditLog', () => {
  it('exige una transacción (como Propagation.MANDATORY)', async () => {
    const log = new AuditLog();
    const notATransaction = { isTransaction: false } as unknown as Transaction<DB>;
    await expect(
      log.record(notATransaction, TENANT, USER, 'X', 'TENANT', TENANT, {}),
    ).rejects.toThrow(/transacción/);
    await expect(
      log.recordFor(notATransaction, person('OWNER'), 'X', 'TENANT', TENANT, {}),
    ).rejects.toThrow(/transacción/);
  });
});
