import { buildAccessKey, isValidAccessKey } from '../../../src/sequence/access-key.js';
import { AccessKeyParts } from '../../../src/sequence/access-key-parts.js';
import { fiscalDateOf } from '../../../src/sequence/fiscal-clock.js';
import { nextNumericCode } from '../../../src/sequence/numeric-code.js';

// Traducción de AccessKeyTest y AccessKeyPartsTest.
it.each([
  ['071020260117900123450011001002000000123123456781', '0710202601179001234500110010020000001231234567816'],
  ['071020260117900123450011001002000000006123456781', '0710202601179001234500110010020000000061234567811'],
  ['071020260117900123450011001002000000008123456781', '0710202601179001234500110010020000000081234567810'],
])('construye el vector documentado %s', (base48, expected) => {
  expect(buildAccessKey(base48)).toBe(expected);
  expect(isValidAccessKey(expected)).toBe(true);
});

it('detecta un dígito alterado', () => {
  expect(isValidAccessKey('0710202601179001234500110010020000001231234567817')).toBe(false);
  expect(isValidAccessKey('0710202601179001234500110010020000001241234567816')).toBe(false);
});

it.each([null, '', '07102026011790012345001100100200000012312345678', '07102026011790012345001100100200000012312345678A'])(
  'rechaza una base que no son 48 dígitos: %j',
  (base48) => {
    expect(() => buildAccessKey(base48 as string)).toThrow(Error);
    expect(isValidAccessKey(base48)).toBe(false);
  },
);

const parts = (sequence: number) =>
  new AccessKeyParts({
    issueDate: '2026-10-07',
    documentType: '01',
    ruc: '1790012345001',
    environment: '1',
    establishment: '001',
    emissionPoint: '002',
    sequence,
    numericCode: '12345678',
    emissionType: '1',
  });

it('construye la base y la clave conservando los ceros iniciales', () => {
  expect(parts(123).toBase48()).toBe('071020260117900123450011001002000000123123456781');
  expect(parts(123).toAccessKey()).toBe('0710202601179001234500110010020000001231234567816');
});

it.each([0, -1, 1_000_000_000, 1.5])('rechaza el secuencial %d', (sequence) => {
  expect(() => parts(sequence)).toThrow(Error);
});

it.each([
  ['issueDate', null],
  ['issueDate', '2026-02-30'],
  ['documentType', '1'],
  ['ruc', '179001234500'],
  ['environment', '3'],
  ['establishment', '1'],
  ['numericCode', '1234567'],
  ['emissionType', '12'],
])('rechaza %s %j', (field, value) => {
  const valid = {
    issueDate: '2026-10-07',
    documentType: '01',
    ruc: '1790012345001',
    environment: '1',
    establishment: '001',
    emissionPoint: '002',
    sequence: 1,
    numericCode: '12345678',
    emissionType: '1',
  };
  expect(() => new AccessKeyParts({ ...valid, [field]: value } as never)).toThrow(Error);
});

it('la fecha fiscal es la fecha local de Ecuador', () => {
  expect(fiscalDateOf(new Date('2026-10-08T03:30:00Z'))).toBe('2026-10-07');
  expect(fiscalDateOf(new Date('2026-10-08T05:00:00Z'))).toBe('2026-10-08');
});

it('el código numérico tiene ocho dígitos', () => {
  for (let i = 0; i < 20; i++) expect(nextNumericCode()).toMatch(/^[0-9]{8}$/);
});
