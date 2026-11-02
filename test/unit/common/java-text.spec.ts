import { codePointLength, strip } from '../../../src/common/java-text.js';

// Por código, para que el fuente no lleve caracteres invisibles.
const chr = (code: number) => String.fromCharCode(code);
const IDEOGRAPHIC_SPACE = chr(0x3000);
const NBSP = chr(0xa0);
const NUL = chr(0);
const NEL = chr(0x85);
const UNIT_SEPARATOR = chr(0x1f);
const FILE_SEPARATOR = chr(0x1c);

describe('strip', () => {
  it('quita los espacios ASCII', () => {
    expect(strip(' a ')).toBe('a');
  });
  it('quita el espacio ideográfico U+3000', () => {
    expect(strip(`${IDEOGRAPHIC_SPACE}a`)).toBe('a');
  });
  it('conserva el espacio de no ruptura', () => {
    expect(strip(`${NBSP}a`)).toBe(`${NBSP}a`);
  });
  it('quita los separadores U+001C a U+001F, que JS no trata como espacio', () => {
    expect(strip(`${UNIT_SEPARATOR}a${FILE_SEPARATOR}`)).toBe('a');
  });
  it('conserva el NUL y U+0085', () => {
    expect(strip(`${NUL}a${NEL}`)).toBe(`${NUL}a${NEL}`);
  });
});

describe('codePointLength', () => {
  it('un emoji cuenta uno', () => {
    expect(codePointLength('😀')).toBe(1);
  });
  it('un sustituto suelto cuenta uno', () => {
    expect(codePointLength(chr(0xd83d))).toBe(1);
    expect(codePointLength(`a${chr(0xd83d)}`)).toBe(2);
  });
  it('texto vacío', () => {
    expect(codePointLength('')).toBe(0);
  });
});
