import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { inspectPkcs12 } from '../../src/certificate/pkcs12-inspector.js';
import { serializeLikeJdk } from '../../src/signature/jdk-serializer.js';
import { parseSigned } from '../../src/signature/xades-profile.js';
import { XadesBesSigner } from '../../src/signature/xades-signer.js';

// Firmas XAdES-BES de XadesBesSigner de Java (tools/golden-generator, familia xades). Con el mismo .p12, la
// misma hora y los mismos números aleatorios, la firma de Node debe salir byte a byte igual: RSA-SHA1 con
// PKCS#1 v1.5 es determinista.
interface Meta {
  signingTime: string;
  p12: string;
  p12Password: string;
  numbers: number[];
}

const dir = new URL('./xades/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, dir));
const cases = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/meta.json`, dir)))
  .map((entry) => entry.name);

/** Los números del golden en el orden en que se pidieron; pedir uno de más es un error de la prueba. */
function numbersOf(meta: Meta): () => number {
  const queue = [...meta.numbers];
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('El firmante pidió más números de los que guarda el golden');
    return next;
  };
}

it('el golden cubre facturas, notas, caracteres especiales y una factura grande', () => {
  expect(cases).toEqual(
    expect.arrayContaining([
      'factura-estandar',
      'factura-con-ruc-proveedor',
      'nota-credito-sobre-factura',
      'nota-debito-dos-tarifas',
      'factura-caracteres-especiales',
      'factura-500-lineas',
    ]),
  );
});

it.each(cases)('%s: la firma sale byte a byte como la de Java', async (name) => {
  const meta = JSON.parse(read(`${name}/meta.json`).toString('utf8')) as Meta;
  expect(meta.numbers).toHaveLength(8);
  const signingTime = new Date(meta.signingTime);
  const material = await inspectPkcs12(read(meta.p12), meta.p12Password, signingTime);
  const signer = new XadesBesSigner(numbersOf(meta));

  const signed = signer.sign(read(`${name}/unsigned.xml`), material, signingTime);

  const expected = read(`${name}/signed.xml`);
  expect(signed.toString('utf8')).toBe(expected.toString('utf8'));
  expect(signed.equals(expected)).toBe(true);
});

it('el XML de borde se reescribe como el Transformer de XadesBesSigner.serialize', () => {
  const input = read('serializacion-jdk/input.xml');
  const expected = read('serializacion-jdk/output.xml');

  const output = serializeLikeJdk(parseSigned(input));

  expect(output.toString('utf8')).toBe(expected.toString('utf8'));
  expect(output.equals(expected)).toBe(true);
});
