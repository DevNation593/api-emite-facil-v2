// Descifra un PKCS#12 con node-forge en un hilo aparte: derivar las claves (MAC, PBES2, PBE de
// PKCS#12) puede costar segundos, y en el hilo principal detendría todas las peticiones. Devuelve
// las bolsas de clave y de certificado con sus atributos y sus bytes; el resto de la lectura (elegir
// la clave, comprobar vigencia) se hace en pkcs12-inspector.ts. JavaScript plano para que el mismo
// archivo funcione desde src/ en las pruebas y desde dist/ en producción.
import { pbkdf2Sync } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import forge from 'node-forge';

const { p12, password } = workerData;
const OIDS = forge.pki.oids;

// forge deriva PBES2 con cada carácter de la contraseña como un byte; Java usa su UTF-8, y así cifra
// keytool. Además se usa el PBKDF2 nativo de Node, mucho más rápido que el de forge.
forge.pkcs5.pbkdf2 = (pass, salt, iterations, keyLength, md) => {
  const digest = md === undefined ? 'sha1' : typeof md === 'string' ? md : md.algorithm;
  return pbkdf2Sync(
    Buffer.from(forge.util.encodeUtf8(pass), 'binary'),
    Buffer.from(salt, 'binary'),
    iterations,
    keyLength,
    digest,
  ).toString('binary');
};

// Los bytes de los que salió cada estructura ASN.1: el certificado se devuelve tal como venía en el
// archivo. forge, al volver a codificarlo, reescribe el algoritmo de firma (NULL de más, parámetros
// de RSA-PSS explícitos) y la huella dejaría de ser la de Java.
const raw = new WeakMap();
const fromDer = forge.asn1.fromDer;
forge.asn1.fromDer = (input, options) => {
  const node = fromDer(input, options);
  if (typeof input === 'string') raw.set(node, input);
  return node;
};
const certificateFromAsn1 = forge.pki.certificateFromAsn1;
forge.pki.certificateFromAsn1 = (node, computeHash) => {
  const certificate = certificateFromAsn1(node, computeHash);
  certificate.originalDer = raw.get(node);
  return certificate;
};

const bytes = (binary) => Buffer.from(binary, 'binary');
const attributes = (bag) => ({
  localKeyId: bag.attributes?.localKeyId?.[0] ?? null,
  friendlyName: bag.attributes?.friendlyName?.[0] ?? null,
});

try {
  const store = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bytes(p12).toString('binary')), false, password);
  const bagsOf = (type) => store.getBags({ bagType: type })[type] ?? [];
  const keys = [...bagsOf(OIDS.pkcs8ShroudedKeyBag), ...bagsOf(OIDS.keyBag)].map((bag) => {
    const info = bag.key
      ? forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(bag.key))
      : bag.asn1;
    return { ...attributes(bag), der: bytes(forge.asn1.toDer(info).getBytes()) };
  });
  const certs = bagsOf(OIDS.certBag).map((bag) => {
    const original = bag.cert ? bag.cert.originalDer : raw.get(bag.asn1);
    const der = original ?? forge.asn1.toDer(bag.cert ? forge.pki.certificateToAsn1(bag.cert) : bag.asn1).getBytes();
    return { ...attributes(bag), der: bytes(der) };
  });
  parentPort.postMessage({ ok: true, keys, certs });
} catch {
  // Contraseña errónea y archivo corrupto no se distinguen.
  parentPort.postMessage({ ok: false });
}
