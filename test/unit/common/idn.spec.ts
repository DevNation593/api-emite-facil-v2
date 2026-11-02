import { idnToAscii } from '../../../src/common/idn.js';

describe('idnToAscii', () => {
  it('un dominio enorme no ASCII no lanza y se rechaza', () => {
    expect(() => idnToAscii('ñ'.repeat(200_000) + '.c')).not.toThrow();
    expect(idnToAscii('ñ'.repeat(200_000) + '.c')).toBeNull();
  });

  it('codifica en punycode una etiqueta normal', () => {
    expect(idnToAscii('bücher.example')).toBe('xn--bcher-kva.example');
  });
});
