import { readFileSync } from 'node:fs';
import { XadesVerifier } from '../../src/signature/xades-verifier.js';

// Resultado de XadesVerifier.verify de Java (tools/golden-generator, familia xades-verify) para las firmas de
// la familia xades y para variantes alteradas de la factura estándar. NestJS debe dar el mismo `valid` y los
// mismos errores, en el mismo orden.
interface Case {
  name: string;
  file: string;
  valid: boolean;
  errors: string[];
}

const { cases } = JSON.parse(readFileSync(new URL('./xades-verify.json', import.meta.url), 'utf8')) as {
  cases: Case[];
};
const verifier = new XadesVerifier();

it('el golden cubre firmas válidas y alteradas', () => {
  expect(cases.length).toBeGreaterThanOrEqual(30);
  expect(cases.filter((c) => c.valid).length).toBeGreaterThanOrEqual(6);
  expect(cases.map((c) => c.name)).toEqual(
    expect.arrayContaining([
      'importe-cambiado',
      'hora-de-firma-cambiada',
      'certificado-cambiado',
      'firmado-con-otra-clave',
      'firma-fuera-de-la-raiz',
      'dos-firmas',
      'cuarta-referencia',
      'transformacion-cambiada',
      'c14n-exclusiva',
      'sin-firmar',
      'ilegible',
    ]),
  );
});

it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
  const xml = readFileSync(new URL(c.file, import.meta.url));
  expect(verifier.verify(xml)).toEqual({ valid: c.valid, errors: c.errors });
});
