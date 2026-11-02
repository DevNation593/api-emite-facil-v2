import { readFileSync } from 'node:fs';
import { Passwords } from '../../src/identity/passwords.js';

interface Case {
  password: string;
  hash: string;
}
const { cases } = JSON.parse(readFileSync(new URL('./argon2.json', import.meta.url), 'utf8')) as {
  cases: Case[];
};

describe('Passwords contra los hashes de Java', () => {
  const passwords = new Passwords();

  it('hay casos', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c, i) => [i, c] as const))(
    'matches acepta el hash del caso %i',
    async (_i, c) => {
      expect(await passwords.matches(c.password, c.hash)).toBe(true);
      expect(await passwords.matches(c.password + 'x', c.hash)).toBe(false);
    },
  );

  it.each(cases.map((c, i) => [i, c] as const))(
    'con la misma sal produce la misma cadena PHC (caso %i)',
    async (_i, c) => {
      // $argon2id$v=19$m=16384,t=2,p=1$<sal>$<hash>
      const salt = Buffer.from(c.hash.split('$')[4]!, 'base64');
      expect(await passwords.hash(c.password, salt)).toBe(c.hash);
    },
  );
});
