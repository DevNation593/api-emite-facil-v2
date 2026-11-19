import { loadConfig } from '../../../src/config/app-config.js';
import {
  createSriConfig,
  isEnabled,
  OFFICIAL_ENDPOINTS,
  sendLeaseMs,
  type SriConfigInput,
} from '../../../src/sri/sri-config.js';
import { testEnv } from '../../support/test-env.js';

// Traducción de sri/SriPropertiesTest.java.
const TEST = { ...OFFICIAL_ENDPOINTS.test };
const PRODUCTION = { ...OFFICIAL_ENDPOINTS.production };

function properties(
  enabled: string[] | null,
  custom: boolean,
  test: SriConfigInput['test'],
): ReturnType<typeof createSriConfig> {
  return createSriConfig({
    enabledEnvironments: enabled,
    allowCustomEndpoints: custom,
    test,
    production: PRODUCTION,
    connectTimeoutMs: 10_000,
    readTimeoutMs: 60_000,
    authorizationDelayMs: 3_000,
    retryBackoffMs: 15_000,
    retryMaxBackoffMs: 3_600_000,
    retryMaxAttempts: 30,
  });
}

it('officialHostsAreAccepted', () => {
  expect(() => properties([], false, TEST)).not.toThrow();
});

it('otherHostIsRejectedUnlessCustomEndpointsAreAllowed', () => {
  const elsewhere = { reception: 'https://ejemplo.test/recepcion', authorization: TEST.authorization };
  expect(() => properties([], false, elsewhere)).toThrow('einvoice.sri');
  expect(() => properties([], true, elsewhere)).not.toThrow();
});

it('plainHttpIsRejected', () => {
  const plain = {
    reception: 'http://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    authorization: TEST.authorization,
  };
  expect(() => properties([], false, plain)).toThrow();
});

it('lookalikeHostIsRejected', () => {
  const lookalike = {
    reception: 'https://celcer.sri.gob.ec.ejemplo.test/recepcion',
    authorization: 'https://ejemplo.test/?celcer.sri.gob.ec',
  };
  expect(() => properties([], false, lookalike)).toThrow();
});

it('una dirección oficial con usuario se rechaza', () => {
  expect(() =>
    properties([], false, { reception: 'https://x@celcer.sri.gob.ec/recepcion', authorization: TEST.authorization }),
  ).toThrow('host oficial');
});

it('missingEndpointIsRejectedEvenWithCustomEndpoints', () => {
  expect(() => properties([], true, { reception: null, authorization: TEST.authorization })).toThrow(
    'einvoice.sri.test.reception debe ser una dirección absoluta',
  );
  expect(() => properties([], true, { reception: 'ftp://ejemplo.test/x', authorization: TEST.authorization })).toThrow(
    'einvoice.sri.test.reception debe ser una dirección http o https',
  );
  expect(() => properties([], true, null)).toThrow('Faltan las direcciones einvoice.sri.test');
});

it('environmentIsEnabledOnlyWhenListed', () => {
  expect(isEnabled(properties([], false, TEST), 'TEST')).toBe(false);
  expect(isEnabled(properties(null, false, TEST), 'TEST')).toBe(false);
  const onlyTest = properties(['1'], false, TEST);
  expect(isEnabled(onlyTest, 'TEST')).toBe(true);
  expect(isEnabled(onlyTest, 'PRODUCTION')).toBe(false);
  expect(onlyTest.endpoints.TEST.reception.href).toBe(TEST.reception);
  expect(onlyTest.endpoints.PRODUCTION.authorization.href).toBe(PRODUCTION.authorization);
});

it('unknownEnvironmentCodeIsRejected', () => {
  expect(() => properties(['3'], false, TEST)).toThrow('enabled-environments');
});

it('sendLeaseCoversBothTimeouts', () => {
  expect(sendLeaseMs(properties([], false, TEST))).toBe(100_000);
});

it('los plazos y el número de intentos se validan como en Java', () => {
  const base = (overrides: Partial<SriConfigInput>) => () =>
    createSriConfig({
      enabledEnvironments: [],
      allowCustomEndpoints: false,
      test: TEST,
      production: PRODUCTION,
      connectTimeoutMs: 1,
      readTimeoutMs: 1,
      authorizationDelayMs: 0,
      retryBackoffMs: 1,
      retryMaxBackoffMs: 1,
      retryMaxAttempts: 1,
      ...overrides,
    });
  expect(base({})).not.toThrow();
  expect(base({ connectTimeoutMs: 0 })).toThrow('einvoice.sri.connect-timeout debe ser mayor que cero');
  expect(base({ readTimeoutMs: 0 })).toThrow('einvoice.sri.read-timeout debe ser mayor que cero');
  expect(base({ retryBackoffMs: 0 })).toThrow('einvoice.sri.retry-backoff debe ser mayor que cero');
  expect(base({ retryMaxBackoffMs: 0 })).toThrow('einvoice.sri.retry-max-backoff debe ser mayor que cero');
  expect(base({ authorizationDelayMs: -1 })).toThrow('einvoice.sri.authorization-delay no puede ser negativo');
  expect(base({ retryMaxAttempts: 0 })).toThrow('einvoice.sri.retry-max-attempts debe ser al menos 1');
});

describe('desde el entorno', () => {
  it('por omisión, los valores de application.yml', () => {
    const { sri } = loadConfig(testEnv);
    expect(sri.enabledEnvironments).toEqual([]);
    expect(sri.allowCustomEndpoints).toBe(false);
    expect(sri.endpoints.TEST.reception.href).toBe(OFFICIAL_ENDPOINTS.test.reception);
    expect(sri.endpoints.TEST.authorization.href).toBe(OFFICIAL_ENDPOINTS.test.authorization);
    expect(sri.endpoints.PRODUCTION.reception.href).toBe(OFFICIAL_ENDPOINTS.production.reception);
    expect(sri.endpoints.PRODUCTION.authorization.href).toBe(OFFICIAL_ENDPOINTS.production.authorization);
    expect(sri).toMatchObject({
      connectTimeoutMs: 10_000,
      readTimeoutMs: 60_000,
      authorizationDelayMs: 3_000,
      retryBackoffMs: 15_000,
      retryMaxBackoffMs: 3_600_000,
      retryMaxAttempts: 40,
    });
  });

  it('lee cada variable', () => {
    const { sri } = loadConfig({
      ...testEnv,
      SRI_ENABLED_ENVIRONMENTS: '1',
      EINVOICE_SRI_ALLOW_CUSTOM_ENDPOINTS: 'TRUE',
      EINVOICE_SRI_TEST_RECEPTION: 'http://127.0.0.1:9/recepcion',
      EINVOICE_SRI_TEST_AUTHORIZATION: 'http://127.0.0.1:9/autorizacion',
      EINVOICE_SRI_PRODUCTION_RECEPTION: 'http://127.0.0.1:9/p/recepcion',
      EINVOICE_SRI_PRODUCTION_AUTHORIZATION: 'http://127.0.0.1:9/p/autorizacion',
      SRI_CONNECT_TIMEOUT: '2s',
      SRI_READ_TIMEOUT: '5s',
      SRI_AUTHORIZATION_DELAY: '0',
      SRI_RETRY_BACKOFF: '1s',
      EINVOICE_SRI_RETRY_MAX_BACKOFF: '1m',
      SRI_RETRY_MAX: '5',
    });
    expect(sri.enabledEnvironments).toEqual(['1']);
    expect(sri.allowCustomEndpoints).toBe(true);
    expect(sri.endpoints.TEST.reception.href).toBe('http://127.0.0.1:9/recepcion');
    expect(sri.endpoints.PRODUCTION.authorization.href).toBe('http://127.0.0.1:9/p/autorizacion');
    expect(sri).toMatchObject({
      connectTimeoutMs: 2_000,
      readTimeoutMs: 5_000,
      authorizationDelayMs: 0,
      retryBackoffMs: 1_000,
      retryMaxBackoffMs: 60_000,
      retryMaxAttempts: 5,
    });
  });

  it('una dirección propia sin permitirla no arranca', () => {
    expect(() => loadConfig({ ...testEnv, EINVOICE_SRI_TEST_RECEPTION: 'http://127.0.0.1:9/recepcion' })).toThrow(
      'einvoice.sri.test.reception debe ser una dirección https de un host oficial del SRI',
    );
  });

  it('valores ilegibles no arrancan', () => {
    expect(() => loadConfig({ ...testEnv, SRI_RETRY_MAX: '0' })).toThrow('retry-max-attempts');
    expect(() => loadConfig({ ...testEnv, SRI_RETRY_MAX: 'muchos' })).toThrow('SRI_RETRY_MAX');
    expect(() => loadConfig({ ...testEnv, SRI_READ_TIMEOUT: 'pronto' })).toThrow('SRI_READ_TIMEOUT');
    expect(() => loadConfig({ ...testEnv, EINVOICE_SRI_ALLOW_CUSTOM_ENDPOINTS: 'si' })).toThrow(
      'EINVOICE_SRI_ALLOW_CUSTOM_ENDPOINTS',
    );
  });
});
