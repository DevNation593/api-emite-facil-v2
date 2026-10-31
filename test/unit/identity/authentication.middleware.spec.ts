import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiException } from '../../../src/common/api-exception.js';
import {
  authenticationMiddleware,
  type AuthenticationDeps,
} from '../../../src/identity/authentication.middleware.js';
import { identityOf } from '../../../src/identity/request-identity.js';

const KEY_ID = '11111111-1111-1111-1111-111111111111';
const TENANT = '22222222-2222-2222-2222-222222222222';
const CREATOR = '33333333-3333-3333-3333-333333333333';
const USER = '44444444-4444-4444-4444-444444444444';
const SESSION = '55555555-5555-5555-5555-555555555555';

function deps(overrides: Partial<AuthenticationDeps> = {}) {
  const calls = {
    verify: vi.fn(async (token: string) =>
      token === 'valido' ? { sub: USER, sid: SESSION } : null,
    ),
    authenticate: vi.fn(async (header: string) =>
      header === 'efk_buena'
        ? { apiKeyId: KEY_ID, tenantId: TENANT, createdBy: CREATOR }
        : null,
    ),
    touch: vi.fn(async () => undefined),
    check: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  };
  const all: AuthenticationDeps = {
    accessTokens: { verify: calls.verify },
    apiKeys: { authenticate: calls.authenticate, touch: calls.touch },
    limiter: { check: calls.check },
    ...overrides,
  };
  return { calls, all };
}

function fakeRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Request {
  return { method, path, headers } as unknown as Request;
}

/** Ejecuta el middleware y devuelve lo que pasó a next(). */
function run(all: AuthenticationDeps, req: Request): Promise<unknown> {
  return new Promise((resolve) => {
    authenticationMiddleware(all)(req, {} as Response, (error?: unknown) => resolve(error));
  });
}

const problem = (error: unknown) => {
  expect(error).toBeInstanceOf(ApiException);
  const e = error as ApiException;
  return { status: e.status, code: e.errorCode, detail: e.detail, retry: e.retryAfterSeconds };
};

describe('sin credenciales', () => {
  it('no toca la base, ni el límite ni el verificador', async () => {
    const { calls, all } = deps();
    expect(problem(await run(all, fakeRequest('GET', '/api/v1/auth/me')))).toEqual({
      status: 401,
      code: 'UNAUTHENTICATED',
      detail: 'Se requiere un token de acceso válido',
      retry: 0,
    });
    expect(await run(all, fakeRequest('POST', '/api/v1/auth/login'))).toBeUndefined();
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.authenticate).not.toHaveBeenCalled();
    expect(calls.touch).not.toHaveBeenCalled();
    expect(calls.check).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/api/v1/auth/register'],
    ['POST', '/api/v1/auth/login'],
    ['POST', '/api/v1/auth/refresh'],
    ['POST', '/api/v1/auth/logout'],
    ['POST', '/api/v1/auth/email-verification'],
    ['POST', '/api/v1/auth/password-reset/request'],
    ['POST', '/api/v1/auth/password-reset'],
    ['GET', '/actuator/health'],
    ['POST', '/actuator/health'],
    ['GET', '/actuator/health/liveness'],
  ])('%s %s es pública', async (method, path) => {
    const { all } = deps();
    expect(await run(all, fakeRequest(method, path))).toBeUndefined();
  });

  it.each([
    ['GET', '/api/v1/auth/login'],
    ['POST', '/api/v1/auth/login/'],
    ['POST', '/api/v1/auth/me'],
    ['POST', '/api/v1/auth/email-verification/resend'],
    ['POST', '/api/v1/auth/password'],
    ['GET', '/actuator/healthx'],
    ['GET', '/actuator/prometheus'],
    ['GET', '/nada'],
    ['GET', '/'],
  ])('%s %s no lo es', async (method, path) => {
    const { all } = deps();
    expect(problem(await run(all, fakeRequest(method, path))).status).toBe(401);
  });
});

describe('Bearer', () => {
  it('con token válido deja la identidad y cuenta para el límite por usuario', async () => {
    const { calls, all } = deps();
    const req = fakeRequest('GET', '/api/v1/x', { authorization: 'Bearer valido' });
    expect(await run(all, req)).toBeUndefined();
    expect(identityOf(req)).toEqual({ kind: 'user', userId: USER, sessionId: SESSION });
    expect(calls.check).toHaveBeenCalledWith(USER, false);
  });

  it.each([
    ['GET', false],
    ['HEAD', false],
    ['OPTIONS', false],
    ['POST', true],
    ['PUT', true],
    ['PATCH', true],
    ['DELETE', true],
  ])('%s cuenta como escritura: %s', async (method, write) => {
    const { calls, all } = deps();
    await run(all, fakeRequest(method, '/api/v1/auth/login', { authorization: 'Bearer valido' }));
    expect(calls.check).toHaveBeenCalledWith(USER, write);
  });

  it('un token inválido da 401 también en rutas públicas', async () => {
    const { calls, all } = deps();
    const req = fakeRequest('POST', '/api/v1/auth/login', { authorization: 'Bearer malo' });
    expect(problem(await run(all, req)).status).toBe(401);
    expect(
      problem(
        await run(all, fakeRequest('GET', '/actuator/health', { authorization: 'Bearer malo' })),
      ).status,
    ).toBe(401);
    expect(calls.check).not.toHaveBeenCalled();
  });

  it.each(['Bearer', 'Bearer ', 'Bearerx valido', 'Bearer valido extra', 'Bearer a$b'])(
    'mal formado (%j) da 401 sin verificar',
    async (header) => {
      const { calls, all } = deps();
      const req = fakeRequest('GET', '/actuator/health', { authorization: header });
      expect(problem(await run(all, req)).status).toBe(401);
      expect(calls.verify).not.toHaveBeenCalled();
    },
  );

  it('el esquema no distingue mayúsculas', async () => {
    const { all } = deps();
    for (const header of ['bearer valido', 'BEARER valido']) {
      expect(
        await run(all, fakeRequest('GET', '/api/v1/x', { authorization: header })),
      ).toBeUndefined();
    }
  });

  it('otro esquema se ignora como si no hubiera credenciales', async () => {
    const { calls, all } = deps();
    expect(
      await run(all, fakeRequest('GET', '/actuator/health', { authorization: 'Basic YTpi' })),
    ).toBeUndefined();
    expect(
      problem(await run(all, fakeRequest('GET', '/api/v1/x', { authorization: 'Basic YTpi' })))
        .status,
    ).toBe(401);
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.check).not.toHaveBeenCalled();
  });
});

describe('X-Api-Key', () => {
  it('con una key válida deja la identidad, anota el uso y cuenta para el límite de la key', async () => {
    const { calls, all } = deps();
    const req = fakeRequest('POST', '/api/v1/x', { 'x-api-key': 'efk_buena' });
    expect(await run(all, req)).toBeUndefined();
    expect(identityOf(req)).toEqual({
      kind: 'apiKey',
      apiKeyId: KEY_ID,
      tenantId: TENANT,
      createdBy: CREATOR,
    });
    expect(calls.touch).toHaveBeenCalledWith(KEY_ID);
    expect(calls.check).toHaveBeenCalledWith(`apikey:${KEY_ID}`, true);
  });

  it('una key inválida o vacía da 401, también en rutas públicas', async () => {
    const { calls, all } = deps();
    for (const value of ['efk_mala', '']) {
      const req = fakeRequest('POST', '/api/v1/auth/login', { 'x-api-key': value });
      expect(problem(await run(all, req)).code).toBe('UNAUTHENTICATED');
    }
    expect(calls.touch).not.toHaveBeenCalled();
    expect(calls.check).not.toHaveBeenCalled();
  });

  it('con Authorization además es ambigua, aunque la key venga vacía', async () => {
    const { calls, all } = deps();
    for (const value of ['efk_buena', '']) {
      const req = fakeRequest('GET', '/actuator/health', {
        'x-api-key': value,
        authorization: 'Bearer valido',
      });
      expect(problem(await run(all, req))).toEqual({
        status: 400,
        code: 'CREDENTIALS_AMBIGUOUS',
        detail: 'Envíe X-Api-Key o Authorization, no las dos',
        retry: 0,
      });
    }
    expect(calls.authenticate).not.toHaveBeenCalled();
    expect(calls.verify).not.toHaveBeenCalled();
  });

  it('un fallo al comprobar la key da 503 y no registra su valor', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      for (const failure of [new Error('base caída efk_buena'), 'texto', undefined]) {
        const { all } = deps({
          apiKeys: {
            authenticate: () => Promise.reject(failure),
            touch: async () => undefined,
          },
        });
        const req = fakeRequest('GET', '/api/v1/x', { 'x-api-key': 'efk_buena' });
        expect(problem(await run(all, req))).toEqual({
          status: 503,
          code: 'INTERNAL_ERROR',
          detail: 'No se pudo comprobar la API key; vuelva a intentar en un momento',
          retry: 0,
        });
      }
      expect(lines).toHaveLength(3);
      expect(lines.join('\n')).not.toContain('efk_buena');
    } finally {
      spy.mockRestore();
    }
  });

  it('un fallo en touch solo se registra y la petición sigue', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      const { calls, all } = deps({
        apiKeys: {
          authenticate: async () => ({ apiKeyId: KEY_ID, tenantId: TENANT, createdBy: CREATOR }),
          touch: () => Promise.reject(new Error('base caída')),
        },
      });
      const req = fakeRequest('GET', '/api/v1/x', { 'x-api-key': 'efk_buena' });
      expect(await run(all, req)).toBeUndefined();
      expect(calls.check).toHaveBeenCalledWith(`apikey:${KEY_ID}`, false);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(KEY_ID);
      expect(lines[0]).not.toContain('efk_buena');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('límite', () => {
  it('un rechazo da 429 con Retry-After', async () => {
    const { all } = deps({
      limiter: { check: async () => ({ allowed: false, retryAfterSeconds: 17 }) },
    });
    const req = fakeRequest('GET', '/api/v1/x', { authorization: 'Bearer valido' });
    expect(problem(await run(all, req))).toEqual({
      status: 429,
      code: 'RATE_LIMITED',
      detail: 'Demasiadas peticiones en poco tiempo; espere unos segundos',
      retry: 17,
    });
  });

  it('un error inesperado del límite sale por next(error)', async () => {
    const boom = new Error('x');
    const { all } = deps({ limiter: { check: () => Promise.reject(boom) } });
    const req = fakeRequest('GET', '/api/v1/x', { authorization: 'Bearer valido' });
    expect(await run(all, req)).toBe(boom);
  });
});

it('identityOf sin autenticación da 401', () => {
  expect(() => identityOf(fakeRequest('GET', '/'))).toThrow(ApiException);
});
