import { decodeJavaBase64 } from '../../../src/common/java-base64.js';
import { offsetDateTimeJson, offsetDateTimeToString } from '../../../src/common/java-time.js';

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
