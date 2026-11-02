import {
  createPrivateKey,
  type KeyObject,
  randomBytes,
  sign,
  verify,
  X509Certificate,
} from 'node:crypto';
import forge from 'node-forge';
import type { ErrorCode } from '../common/error-codes.js';
import { x500Name } from './x500-name.js';

/** El certificado no sirve para firmar; errorCode dice por qué, sin datos del certificado ni de su clave. */
export class CertificateRejectedException extends Error {
  constructor(
    readonly errorCode: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CertificateRejectedException';
  }
}

/** Lo que la API guarda y muestra de un certificado, con los textos de Java. */
export interface CertificateInfo {
  /** `X500Principal.getName()`. */
  subject: string;
  issuer: string;
  /** El número de serie en decimal, como `BigInteger.toString()`. */
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  publicKey: KeyObject;
  /** Si declara el uso digitalSignature en KeyUsage. */
  digitalSignature: boolean;
}

/** Clave privada y certificado con los que se firma un comprobante. Vive solo en memoria. */
export interface SigningMaterial {
  privateKey: KeyObject;
  certificate: CertificateInfo;
  certificateDer: Buffer;
}

/** La ficha técnica del SRI (6.8) pide RSA de 2048 bits. */
const MIN_RSA_BITS = 2048;
const OIDS = forge.pki.oids;
const KEY_USAGE = '2.5.29.15';

const unreadable = () =>
  new CertificateRejectedException(
    'CERTIFICATE_UNREADABLE',
    'El archivo no es un PKCS#12 válido o la contraseña es incorrecta',
  );

/** Un INTEGER de ASN.1 (complemento a dos) en decimal. */
function integer(bytes: string): string {
  const hex = Buffer.from(bytes, 'binary').toString('hex') || '00';
  let value = BigInt(`0x${hex}`);
  if ((Buffer.from(bytes, 'binary')[0] ?? 0) & 0x80) value -= 1n << BigInt(hex.length * 4);
  return value.toString();
}

/** KeyUsage: si el bit 0 (digitalSignature) está puesto. Sin la extensión, false. */
function declaresDigitalSignature(extensions: forge.asn1.Asn1 | undefined): boolean {
  const list = (extensions?.value as forge.asn1.Asn1[] | undefined)?.[0]?.value as forge.asn1.Asn1[] | undefined;
  for (const extension of list ?? []) {
    const parts = extension.value as forge.asn1.Asn1[];
    if (forge.asn1.derToOid(parts[0]!.value as string) !== KEY_USAGE) continue;
    const octets = parts[parts.length - 1]!.value as string;
    const bits = Buffer.from(forge.asn1.fromDer(octets).value as string, 'binary');
    // El primer byte de un BIT STRING es el número de bits sin usar.
    return bits.length > 1 && (bits[1]! & 0x80) !== 0;
  }
  return false;
}

/** Lee del DER lo que Java toma de X509Certificate. */
export function certificateInfo(der: Buffer): CertificateInfo {
  const tbs = (forge.asn1.fromDer(der.toString('binary')).value as forge.asn1.Asn1[])[0]!;
  const fields = tbs.value as forge.asn1.Asn1[];
  // La versión ([0]) es opcional.
  const start = fields[0]!.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  const extensions = fields.find((f) => f.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && f.type === 3);
  const x509 = new X509Certificate(der);
  return {
    subject: x500Name(fields[start + 4]!),
    issuer: x500Name(fields[start + 2]!),
    serialNumber: integer(fields[start]!.value as string),
    notBefore: x509.validFromDate,
    notAfter: x509.validToDate,
    publicKey: x509.publicKey,
    digitalSignature: declaresDigitalSignature(extensions),
  };
}

interface Bag {
  attributes: { localKeyId?: string[]; friendlyName?: string[] };
  key?: forge.pki.PrivateKey | null;
  cert?: forge.pki.Certificate | null;
  asn1?: forge.asn1.Asn1;
}

/**
 * forge deriva la clave PBES2 (PBKDF2) con cada carácter de la contraseña como un byte; Java usa su
 * UTF-8, y así cifra keytool. Mientras dura la lectura, PBKDF2 recibe la contraseña en UTF-8; el MAC
 * y el PBE heredado usan la derivación de PKCS#12 (UTF-16), que forge ya hace como Java. La lectura
 * es síncrona, así que el cambio no alcanza a ningún otro uso de forge.
 */
function withUtf8Pbkdf2<T>(read: () => T): T {
  const pkcs5 = forge.pkcs5 as unknown as { pbkdf2: (password: string, ...rest: unknown[]) => unknown };
  const original = pkcs5.pbkdf2;
  pkcs5.pbkdf2 = (password, ...rest) => original(forge.util.encodeUtf8(password), ...rest);
  try {
    return read();
  } finally {
    pkcs5.pbkdf2 = original;
  }
}

function load(p12: Buffer, password: string): forge.pkcs12.Pkcs12Pfx {
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12.toString('binary')));
    return withUtf8Pbkdf2(() => forge.pkcs12.pkcs12FromAsn1(asn1, false, password));
  } catch {
    // Contraseña errónea y archivo corrupto no se distinguen: el mensaje no da pistas de cuál fue.
    throw unreadable();
  }
}

function bags(store: forge.pkcs12.Pkcs12Pfx, type: string): Bag[] {
  return (store.getBags({ bagType: type })[type] ?? []) as unknown as Bag[];
}

function keyDer(bag: Bag): Buffer {
  const asn1 = bag.key
    ? forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(bag.key as forge.pki.rsa.PrivateKey))
    : bag.asn1!;
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

function certDer(bag: Bag): Buffer {
  const asn1 = bag.cert ? forge.pki.certificateToAsn1(bag.cert) : bag.asn1!;
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

/** El certificado de una clave: el que comparte su localKeyId (o, si no lo hay, su friendlyName). */
function certificateOf(key: Bag, certs: Bag[]): Bag | undefined {
  const id = key.attributes.localKeyId?.[0];
  if (id !== undefined) return certs.find((c) => c.attributes.localKeyId?.[0] === id);
  const name = key.attributes.friendlyName?.[0];
  return name === undefined ? undefined : certs.find((c) => c.attributes.friendlyName?.[0] === name);
}

/** Firma unos bytes con la clave privada y los verifica con el certificado. */
function matches(material: SigningMaterial): boolean {
  try {
    const probe = randomBytes(32);
    const signature = sign('sha256', probe, material.privateKey);
    return verify('sha256', probe, material.certificate.publicKey, signature);
  } catch {
    return false;
  }
}

function choose(withKey: SigningMaterial[]): SigningMaterial {
  const signing = withKey.filter((m) => m.certificate.digitalSignature);
  if (signing.length === 1) return signing[0]!;
  if (signing.length === 0 && withKey.length === 1) return withKey[0]!;
  throw new CertificateRejectedException(
    'CERTIFICATE_AMBIGUOUS',
    'El archivo contiene más de una clave que podría ser la de firma',
  );
}

/**
 * Lee un PKCS#12 y elige la clave de firma, como Pkcs12Inspector de Java. Los certificados
 * ecuatorianos suelen traer dos claves, una de firma y otra de cifrado: se usa la que declara el
 * uso digitalSignature. La vigencia se juzga en el instante `now`.
 */
export function inspectPkcs12(p12: Buffer, password: string, now: Date): SigningMaterial {
  const store = load(p12, password);
  const certs = bags(store, OIDS.certBag!);
  const withKey: SigningMaterial[] = [];
  try {
    for (const key of [...bags(store, OIDS.pkcs8ShroudedKeyBag!), ...bags(store, OIDS.keyBag!)]) {
      const cert = certificateOf(key, certs);
      if (cert === undefined) continue;
      const certificateDer = certDer(cert);
      withKey.push({
        privateKey: createPrivateKey({ key: keyDer(key), format: 'der', type: 'pkcs8' }),
        certificate: certificateInfo(certificateDer),
        certificateDer,
      });
    }
  } catch {
    throw new CertificateRejectedException('CERTIFICATE_UNREADABLE', 'No se pudo leer la clave del certificado');
  }
  if (withKey.length === 0) {
    throw new CertificateRejectedException(
      'CERTIFICATE_NO_PRIVATE_KEY',
      'El archivo no contiene un certificado con clave privada',
    );
  }
  const chosen = choose(withKey);
  const publicKey = chosen.certificate.publicKey;
  const rsa = publicKey.asymmetricKeyType === 'rsa' || publicKey.asymmetricKeyType === 'rsa-pss';
  if (!rsa || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) {
    throw new CertificateRejectedException(
      'CERTIFICATE_KEY_UNSUPPORTED',
      'La clave del certificado debe ser RSA de al menos 2048 bits',
    );
  }
  if (!matches(chosen)) {
    throw new CertificateRejectedException(
      'CERTIFICATE_KEY_MISMATCH',
      'La clave privada del archivo no corresponde a su certificado',
    );
  }
  if (now < chosen.certificate.notBefore) {
    throw new CertificateRejectedException('CERTIFICATE_NOT_YET_VALID', 'El certificado aún no está vigente');
  }
  if (now > chosen.certificate.notAfter) {
    throw new CertificateRejectedException('CERTIFICATE_EXPIRED', 'El certificado está caducado');
  }
  return chosen;
}
