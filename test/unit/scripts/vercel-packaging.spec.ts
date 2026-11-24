import { existsSync, readFileSync } from 'node:fs';
import { XMLLINT_WASM } from '../../../src/xml/xsd-validator.js';

const read = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('empaquetado para Vercel', () => {
  it('fija NestJS y el dist/ de nest build', () => {
    expect(JSON.parse(read('vercel.json'))).toMatchObject({
      framework: 'nestjs',
      outputDirectory: 'dist',
    });
  });

  it('vite no es dependencia directa: Vercel tomaría la API por un sitio estático', () => {
    const { dependencies, devDependencies } = JSON.parse(read('package.json'));
    expect({ ...dependencies, ...devDependencies }).not.toHaveProperty('vite');
  });

  it('main.ts importa @nestjs/core, lo que Vercel exige a la entrada', () => {
    expect(read('src/main.ts')).toMatch(/^import '@nestjs\/core';$/m);
  });

  it('el motor de xmllint-wasm existe donde lo referencia el validador', () => {
    expect(existsSync(XMLLINT_WASM)).toBe(true);
  });
});
