import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import forge from 'node-forge';

/*
 * Archivos PKCS#12 de prueba, como TestCertificates de Java. Los que dependen de la fecha se crean
 * en el momento (un .p12 guardado caducaría); "dos claves de firma" sale del golden, porque forge
 * no escribe un almacén con dos claves. Son autofirmados y no sirven ante el SRI.
 */

export const TEST_P12_PASSWORD = 'clave-de-prueba-p12';

export type TestP12 =
  | 'valid'
  | 'anotherValid'
  | 'expired'
  | 'notYetValid'
  | 'shortKey'
  | 'withoutPrivateKey'
  | 'mismatchedKey'
  | 'twoSigningKeys';

const DAY = 24 * 3600 * 1000;

interface Pair {
  key: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
}

function pair(bits: number, startDays: number, validityDays: number): Pair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const key = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  // Positivo: el primer byte por debajo de 0x80.
  cert.serialNumber = `0${randomBytes(8).toString('hex')}`;
  const start = new Date(Math.floor(Date.now() / 1000) * 1000 + startDays * DAY);
  cert.validity.notBefore = start;
  cert.validity.notAfter = new Date(start.getTime() + validityDays * DAY);
  // En el orden en que keytool codifica -dname "CN=…, O=…, C=EC": del país al nombre común.
  const name = [
    { name: 'countryName', value: 'EC' },
    { name: 'organizationName', value: 'Pruebas' },
    { name: 'commonName', value: 'Emisor de Pruebas firma' },
  ];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([{ name: 'keyUsage', digitalSignature: true }]);
  cert.sign(key, forge.md.sha256.create());
  return { key, cert };
}

function store(key: forge.pki.rsa.PrivateKey | null, cert: forge.pki.Certificate): Buffer {
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], TEST_P12_PASSWORD, { algorithm: 'aes256' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

const cache = new Map<TestP12, Buffer>();

function create(kind: TestP12): Buffer {
  switch (kind) {
    case 'valid':
    case 'anotherValid': {
      const { key, cert } = pair(2048, -1, 365);
      return store(key, cert);
    }
    case 'expired': {
      const { key, cert } = pair(2048, -30, 5);
      return store(key, cert);
    }
    case 'notYetValid': {
      const { key, cert } = pair(2048, 5, 365);
      return store(key, cert);
    }
    case 'shortKey': {
      const { key, cert } = pair(1024, -1, 365);
      return store(key, cert);
    }
    case 'withoutPrivateKey':
      return store(null, pair(2048, -1, 365).cert);
    case 'mismatchedKey':
      return store(pair(2048, -1, 365).key, pair(2048, -1, 365).cert);
    case 'twoSigningKeys':
      return readFileSync(new URL('../golden/certificates/dos-claves-de-firma.p12', import.meta.url));
  }
}

/** El .p12 de ese tipo, creado una vez por proceso; contraseña TEST_P12_PASSWORD. */
export function testP12(kind: TestP12): Buffer {
  let p12 = cache.get(kind);
  if (p12 === undefined) {
    p12 = create(kind);
    cache.set(kind, p12);
  }
  return Buffer.from(p12);
}
