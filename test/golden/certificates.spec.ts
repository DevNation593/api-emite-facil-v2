import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import forge from 'node-forge';
import {
  CertificateRejectedException,
  inspectPkcs12,
} from '../../src/certificate/pkcs12-inspector.js';
import { x500Name } from '../../src/certificate/x500-name.js';

// .p12 de keytool leídos con Pkcs12Inspector de Java (tools/golden-generator, familia certificates).
type Result =
  | {
      subject: string;
      issuer: string;
      serialNumber: string;
      fingerprintSha256: string;
      validFrom: string;
      validTo: string;
    }
  | { errorCode: string; message: string };
interface Case {
  name: string;
  file: string;
  password: string;
  result: Result;
}
const golden = JSON.parse(
  readFileSync(new URL('./certificates/certificates.json', import.meta.url), 'utf8'),
) as { inspectedAt: string; cases: Case[] };
const at = new Date(golden.inspectedAt);
const read = (file: string) => readFileSync(new URL(`./certificates/${file}`, import.meta.url));

it('el golden cubre los casos de Pkcs12InspectorTest y los de certificados reales', () => {
  const names = golden.cases.map((c) => c.name);
  for (const name of ['valido', 'clave-ec', 'contrasena-con-enie', 'heredado', 'dn-especial', 'basura']) {
    expect(names).toContain(name);
  }
});

it.each(golden.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
  if ('errorCode' in c.result) {
    const error = await inspectPkcs12(read(c.file), c.password, at).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CertificateRejectedException);
    expect(error).toMatchObject({ errorCode: c.result.errorCode, message: c.result.message });
    return;
  }
  const material = await inspectPkcs12(read(c.file), c.password, at);
  expect({
    subject: material.certificate.subject,
    issuer: material.certificate.issuer,
    serialNumber: material.certificate.serialNumber,
    fingerprintSha256: createHash('sha256').update(material.certificateDer).digest('hex'),
    validFrom: material.certificate.notBefore.toISOString().replace('.000Z', 'Z'),
    validTo: material.certificate.notAfter.toISOString().replace('.000Z', 'Z'),
  }).toEqual(c.result);
  expect(material.privateKey.type).toBe('private');
  expect(material.certificate.publicKey.asymmetricKeyType).toBe('rsa');
});

it('la vigencia se juzga en el instante indicado (validityIsJudgedAtTheGivenInstant)', async () => {
  const valid = golden.cases.find((c) => c.name === 'valido')!;
  const later = new Date(at.getTime() + 550 * 24 * 3600 * 1000);
  await expect(inspectPkcs12(read(valid.file), valid.password, later)).rejects.toMatchObject({
    errorCode: 'CERTIFICATE_EXPIRED',
  });
});

describe('archivos costosos de leer', () => {
  /** El .p12 válido con el contador de iteraciones de su MAC cambiado. */
  function withMacIterations(iterations: number): Buffer {
    const pfx = forge.asn1.fromDer(read('valido.p12').toString('binary'));
    const mac = (pfx.value as forge.asn1.Asn1[])[2]!;
    const count = (mac.value as forge.asn1.Asn1[])[2]!;
    count.value = forge.util.hexToBytes(iterations.toString(16).padStart(8, '0'));
    return Buffer.from(forge.asn1.toDer(pfx).getBytes(), 'binary');
  }

  it('más de 5 000 000 iteraciones se rechazan sin derivar la clave, como PKCS12KeyStore', async () => {
    // Comprobado con KeyStore.load de Java 25: "MAC iteration count too large: 2147483647" en 191 ms.
    const started = Date.now();
    await expect(inspectPkcs12(withMacIterations(2 ** 31 - 1), 'clave-de-prueba-p12', at)).rejects.toMatchObject({
      errorCode: 'CERTIFICATE_UNREADABLE',
      message: 'El archivo no es un PKCS#12 válido o la contraseña es incorrecta',
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('leer un archivo válido pero costoso no detiene el resto del proceso', async () => {
    const slow = golden.cases.find((c) => c.name === 'iteraciones-altas')!;
    let last = Date.now();
    let longestGap = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    }, 10);
    try {
      await inspectPkcs12(read(slow.file), slow.password, at);
    } finally {
      // Si la lectura bloquea, el temporizador no llega a correr: el hueco final también cuenta.
      longestGap = Math.max(longestGap, Date.now() - last);
      clearInterval(timer);
    }
    expect(longestGap).toBeLessThan(200);
  }, 120_000);
});

describe('x500Name, como X500Principal.getName()', () => {
  const name = (...rdns: Array<Array<[string, number, string]>>) => {
    const forgeAsn1 = forge.asn1;
    return forgeAsn1.create(
      forgeAsn1.Class.UNIVERSAL,
      forgeAsn1.Type.SEQUENCE,
      true,
      rdns.map((rdn) =>
        forgeAsn1.create(
          forgeAsn1.Class.UNIVERSAL,
          forgeAsn1.Type.SET,
          true,
          rdn.map(([oid, tag, value]) =>
            forgeAsn1.create(forgeAsn1.Class.UNIVERSAL, forgeAsn1.Type.SEQUENCE, true, [
              forgeAsn1.create(forgeAsn1.Class.UNIVERSAL, forgeAsn1.Type.OID, false, forgeAsn1.oidToDer(oid).getBytes()),
              forgeAsn1.create(forgeAsn1.Class.UNIVERSAL, tag, false, value),
            ]),
          ),
        ),
      ),
    );
  };
  const UTF8 = forge.asn1.Type.UTF8;
  const PRINTABLE = forge.asn1.Type.PRINTABLESTRING;

  it('invierte el orden, escapa y usa # para los atributos sin nombre', () => {
    expect(
      x500Name(
        name(
          [['2.5.4.6', PRINTABLE, 'EC']],
          [['2.5.4.5', PRINTABLE, '0912']],
          [['2.5.4.3', UTF8, forge.util.encodeUtf8(String.raw`a=b+c;d<e>f"g\h#i,ñ`)]],
        ),
      ),
    ).toBe(String.raw`CN=a\=b\+c\;d\<e\>f\"g\\h\#i\,ñ,2.5.4.5=#130430393132,C=EC`);
  });

  it('escapa los espacios de los extremos y une con + un RDN de varios valores', () => {
    expect(
      x500Name(name([['2.5.4.10', UTF8, ' O '], ['2.5.4.11', UTF8, 'U']], [['0.9.2342.19200300.100.1.25', 0x16, 'ec']])),
    ).toBe(String.raw`DC=ec,O=\ O\ +OU=U`);
  });
});
