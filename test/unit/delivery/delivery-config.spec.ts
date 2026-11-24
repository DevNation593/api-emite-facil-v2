import { createDeliveryConfig, type DeliveryConfig, validAddress } from '../../../src/delivery/delivery-config.js';
import { retryDelayMs } from '../../../src/orchestration/retry-policy.js';

// Traducción de delivery/DeliveryPropertiesTest.java.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function config(overrides: Partial<DeliveryConfig> = {}): DeliveryConfig {
  return createDeliveryConfig({
    email: { enabled: false, from: null },
    retryBackoffMs: MINUTE,
    retryMaxBackoffMs: 6 * HOUR,
    retryMaxAttempts: 8,
    sendLeaseMs: 2 * MINUTE,
    maxPerDocument: 10,
    ...overrides,
  });
}

it('disabledNeedsNothing', () => {
  expect(() => config({ email: { enabled: false, from: '' } })).not.toThrow();
  expect(config().email.enabled).toBe(false);
});

it('enabledWithoutSenderIsRejected', () => {
  for (const from of [null, '', '  ', 'no-es-un-correo', 'a@b.test\r\nBcc: x@evil.test', 'Nombre <a@b.test>']) {
    expect(() => config({ email: { enabled: true, from } })).toThrow('einvoice.delivery.email.from');
  }
  expect(() => config({ email: { enabled: true, from: 'facturas@plataforma.test' } })).not.toThrow();
});

it('onlyASingleAddressIsValid', () => {
  expect(validAddress('ana.perez+facturas@mi-empresa.com.ec')).toBe(true);
  // Sintaxis de grupo y listas: un solo valor que el servidor expandiría a varios destinatarios.
  for (const several of [
    'grupo:a@x.test,b@y.test;',
    'grupo:a@x.test;',
    'a@x.test,b@y.test',
    'a@x.test;b@y.test',
    'a@x.test b@y.test',
    '<a@x.test>',
    '"Ana" <a@x.test>',
    'a@x.test (Ana)',
  ]) {
    expect(validAddress(several), several).toBe(false);
  }
});

it('defaultRetriesInsistForMostOfADay', () => {
  // Valores por defecto: 1 minuto que se duplica hasta 6 horas, 12 intentos.
  let shortest = 0;
  for (let attempt = 1; attempt < 12; attempt++) shortest += retryDelayMs(attempt, MINUTE, 6 * HOUR, 0);
  expect(shortest).toBeGreaterThan(16 * HOUR);
  // Con 8, el valor inicial, la insistencia no llegaba a dos horas.
  let eight = 0;
  for (let attempt = 1; attempt < 8; attempt++) eight += retryDelayMs(attempt, MINUTE, 6 * HOUR, 0.999);
  expect(eight).toBeLessThan(3 * HOUR);
});

it('limitsMustBePositive', () => {
  expect(() => config({ retryBackoffMs: 0 })).toThrow('einvoice.delivery.retry-backoff debe ser mayor que cero');
  expect(() => config({ retryMaxBackoffMs: 0 })).toThrow('einvoice.delivery.retry-max-backoff debe ser mayor que cero');
  expect(() => config({ sendLeaseMs: -1 })).toThrow('einvoice.delivery.send-lease debe ser mayor que cero');
  expect(() => config({ retryMaxAttempts: 0 })).toThrow('einvoice.delivery.retry-max-attempts debe ser al menos 1');
  expect(() => config({ maxPerDocument: 0 })).toThrow('einvoice.delivery.max-per-document debe ser al menos 1');
});
