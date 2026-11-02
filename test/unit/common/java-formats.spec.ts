import { decodeJavaBase64 } from '../../../src/common/java-base64.js';
import { isoInstant, offsetDateTimeJson, offsetDateTimeToString } from '../../../src/common/java-time.js';

describe('decodeJavaBase64, como Base64.getDecoder()', () => {
  it.each([
    ['QUJD', 'ABC'],
    ['QUI', 'AB'],
    ['QQ', 'A'],
    ['QQ==', 'A'],
    ['QUI=', 'AB'],
    ['', ''],
  ])('%j da %j', (text, expected) => {
    expect(decodeJavaBase64(text)?.toString('latin1')).toBe(expected);
  });

  it.each(['QUJD\nREVG', 'QUJD\r\n', ' QUJD', 'Pz8-Pz8_', 'Q', 'QUJDR', 'QQ===', 'QQ=', 'Q===', 'QQ==QUJD', 'QU*D'])(
    'rechaza %j',
    (text) => {
      expect(decodeJavaBase64(text)).toBeNull();
    },
  );
});

describe('fechas de Java', () => {
  it('en JSON, OffsetDateTime lleva siempre los segundos y la fracción solo si la hay', () => {
    expect(offsetDateTimeJson(new Date('2027-11-01T01:16:00.000Z'))).toBe('2027-11-01T01:16:00Z');
    expect(offsetDateTimeJson(new Date('2027-11-01T01:16:02.500Z'))).toBe('2027-11-01T01:16:02.5Z');
  });

  it('toString() omite los segundos cuando son cero', () => {
    expect(offsetDateTimeToString(new Date('2027-11-01T01:16:00.000Z'))).toBe('2027-11-01T01:16Z');
    expect(offsetDateTimeToString(new Date('2027-11-01T01:16:02.000Z'))).toBe('2027-11-01T01:16:02Z');
    expect(offsetDateTimeToString(new Date('2027-11-01T01:16:02.120Z'))).toBe('2027-11-01T01:16:02.120Z');
  });
});

describe('isoInstant, el ISO_INSTANT de Jackson', () => {
  it('escribe la fracción con 0, 3 o 6 dígitos según haga falta', () => {
    expect(isoInstant('2026-11-02T15:15:30.123456')).toBe('2026-11-02T15:15:30.123456Z');
    expect(isoInstant('2026-11-02T15:15:30.120000')).toBe('2026-11-02T15:15:30.120Z');
    expect(isoInstant('2026-11-02T15:15:30.000000')).toBe('2026-11-02T15:15:30Z');
    expect(isoInstant('2026-11-02T15:15:30.000001')).toBe('2026-11-02T15:15:30.000001Z');
    expect(isoInstant('2026-11-02T15:15:30.001000')).toBe('2026-11-02T15:15:30.001Z');
    expect(isoInstant('2026-11-02T15:15:30.100000')).toBe('2026-11-02T15:15:30.100Z');
  });

  it('siempre lleva los segundos', () => {
    expect(isoInstant('2026-11-02T15:15:00.000000')).toBe('2026-11-02T15:15:00Z');
  });

  it.each(['2026-11-02 15:15:30.123456', '2026-11-02T15:15:30.123456Z', '2026-11-02T15:15', 'x'])('rechaza %j', (text) => {
    expect(() => isoInstant(text)).toThrow(Error);
  });
});
