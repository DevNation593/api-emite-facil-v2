import { sslOption } from '../../../src/database/database.module.js';

describe('sslOption', () => {
  it('sin sslmode no hay TLS', () => {
    expect(sslOption(undefined)).toBeUndefined();
  });
  it('disable no hay TLS', () => {
    expect(sslOption('disable')).toBe(false);
  });
  it('require cifra sin verificar', () => {
    expect(sslOption('require')).toEqual({ rejectUnauthorized: false });
  });
  it('verify-full verifica cadena y nombre', () => {
    expect(sslOption('verify-full')).toBe(true);
  });
  it('verify-ca verifica la cadena pero no el nombre', () => {
    const option = sslOption('verify-ca') as {
      rejectUnauthorized: boolean;
      checkServerIdentity: () => unknown;
    };
    expect(option.rejectUnauthorized).toBe(true);
    expect(option.checkServerIdentity()).toBeUndefined();
  });
});
