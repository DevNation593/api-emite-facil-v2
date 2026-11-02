import { readFileSync } from 'node:fs';
import { hashApiKeySecret, parseApiKey } from '../../src/apikey/api-key-credential.js';

const { cases } = JSON.parse(readFileSync(new URL('./api-key.json', import.meta.url), 'utf8')) as {
  cases: Array<{ value: string; publicId: string; secretHash: string }>;
};

describe('API keys generadas por Java', () => {
  it('hay casos', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c, i) => [i, c] as const))('caso %i: parse y hash coinciden', (_i, c) => {
    const parsed = parseApiKey(c.value);
    expect(parsed).not.toBeNull();
    expect(parsed!.publicId).toBe(c.publicId);
    expect(c.value.endsWith(parsed!.secret)).toBe(true);
    expect(hashApiKeySecret(parsed!.secret)).toBe(c.secretHash);
  });
});
