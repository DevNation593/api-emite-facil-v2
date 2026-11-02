import { clientAddress } from '../../../src/identity/client-address.js';

const ip = (hops: number, ...headers: string[]) => clientAddress(headers, '198.51.100.7', hops);

describe('clientAddress', () => {
  it('un proxy que reemplaza la cabecera deja una sola entrada', () => {
    expect(ip(1, '203.0.113.9')).toBe('203.0.113.9');
    expect(ip(1, ' 2001:db8::1 ')).toBe('2001:db8::1');
  });

  it('lo que escribe quien llama a la izquierda no cuenta', () => {
    expect(clientAddress('1.1.1.1, 2.2.2.2', '9.9.9.9', 1)).toBe('2.2.2.2');
    expect(clientAddress('1.1.1.1, 2.2.2.2', '9.9.9.9', 2)).toBe('1.1.1.1');
    expect(ip(1, '1.2.3.4, 5.6.7.8, 203.0.113.9')).toBe('203.0.113.9');
    expect(ip(2, '1.2.3.4, 203.0.113.9, 10.8.0.3')).toBe('203.0.113.9');
  });

  it('varias cabeceras cuentan como una sola lista', () => {
    expect(ip(1, '1.2.3.4', '203.0.113.9')).toBe('203.0.113.9');
    expect(ip(2, '1.2.3.4', '203.0.113.9, 10.8.0.3')).toBe('203.0.113.9');
  });

  it('con menos entradas que proxies gana la primera', () => {
    expect(ip(2, '203.0.113.9')).toBe('203.0.113.9');
  });

  it('una entrada vacía o demasiado larga no es una dirección: se usa la del que llama', () => {
    expect(ip(1)).toBe('198.51.100.7');
    expect(ip(1, '  ')).toBe('198.51.100.7');
    expect(ip(1, '203.0.113.9, ')).toBe('198.51.100.7');
    expect(ip(1, 'x'.repeat(65))).toBe('198.51.100.7');
    expect(ip(1, 'x'.repeat(64))).toBe('x'.repeat(64));
    // La basura a la izquierda no estorba.
    expect(ip(1, 'x'.repeat(500) + ',, 203.0.113.9')).toBe('203.0.113.9');
  });

  it('sin cabecera usa la dirección remota, quitando ::ffff:', () => {
    expect(clientAddress(undefined, '::ffff:9.9.9.9', 1)).toBe('9.9.9.9');
    expect(clientAddress(undefined, '198.51.100.7', 1)).toBe('198.51.100.7');
    expect(clientAddress(undefined, undefined, 1)).toBe('unknown');
  });

  it('no quita ::ffff: de una entrada de la cabecera', () => {
    expect(clientAddress('::ffff:1.2.3.4', '9.9.9.9', 1)).toBe('::ffff:1.2.3.4');
  });
});
