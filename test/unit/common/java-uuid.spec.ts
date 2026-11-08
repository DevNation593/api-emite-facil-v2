import { jacksonUuid, javaUuidFromString } from '../../../src/common/java-uuid.js';

const ID = '0b427a9f-d598-4668-ba21-787c34379f5f';

describe('javaUuidFromString, como UUID.fromString', () => {
  it.each([
    [ID, ID],
    [ID.toUpperCase(), ID],
    ['1-2-3-4-5', '00000001-0002-0003-0004-000000000005'],
    ['+1-2-3-4-5', '00000001-0002-0003-0004-000000000005'],
    // Cada tramo se enmascara a su ancho, como los & de fromString1.
    ['1-2-3-4-1234567890abcd', '00000001-0002-0003-0004-34567890abcd'],
    ['1-12345-3-4-5', '00000001-2345-0003-0004-000000000005'],
    ['-1-2-3-4-5', null],
  ])('%j da %j', (text, expected) => {
    expect(javaUuidFromString(text)).toBe(expected);
  });

  it.each(['', 'abc', 'x-y-z-w-v', '1-2-3-4', '1-2-3-4-5-6', '0b427a9fd5984668ba21787c34379f5f', `${ID}0`, '1--3-4-5'])(
    'rechaza %j',
    (text) => {
      expect(javaUuidFromString(text)).toBeNull();
    },
  );
});

describe('jacksonUuid, como UUIDDeserializer', () => {
  it('admite la forma canónica en cualquier caja y la devuelve en minúsculas', () => {
    expect(jacksonUuid(ID.toUpperCase())).toBe(ID);
  });

  it('lee 24 caracteres como los 16 bytes en Base64', () => {
    expect(jacksonUuid('C0J6n9WYRmi6IXh8NDefXw==')).toBe(ID);
  });

  it.each(['1-2-3-4-5', `{${ID}}`, ID.replaceAll('-', ''), `${ID.slice(0, 35)}g`, 'x'])('rechaza %j', (text) => {
    expect(jacksonUuid(text)).toBeNull();
  });
});
