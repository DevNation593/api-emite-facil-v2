import {
  createPrivateKey,
  type KeyObject,
  randomBytes,
  sign,
  verify,
  X509Certificate,
} from 'node:crypto';
import { Worker } from 'node:worker_threads';
import forge from 'node-forge';
import type { ErrorCode } from '../common/error-codes.js';
import { MAX_ITERATION_COUNT, maxIterationCount } from './pkcs12-limits.js';
import { x500Name } from './x500-name.js';

/**
 * Por qué un certificado no sirve. CERTIFICATE_MISSING no llega a ninguna respuesta HTTP: lo
 * registra el proceso de firma (E4) cuando el emisor no tiene certificado activo.
 */
export type CertificateErrorCode = Extract<ErrorCode, `CERTIFICATE_${string}`> | 'CERTIFICATE_MISSING';

/** El certificado no sirve para firmar; errorCode dice por qué, sin datos del certificado ni de su clave. */
export class CertificateRejectedException extends Error {
  constructor(
    readonly errorCode: CertificateErrorCode,
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

/** Una bolsa del archivo, tal como la devuelve el worker. */
interface Bag {
  localKeyId: string | null;
  friendlyName: string | null;
  der: Uint8Array;
}

type WorkerResult = { ok: true; keys: Bag[]; certs: Bag[] } | { ok: false };

const WORKER = new URL('./pkcs12-bags.worker.mjs', import.meta.url);

/**
 * Descifra el archivo en un hilo aparte (pkcs12-bags.worker.mjs): la derivación de claves puede
 * costar segundos y no debe detener el resto de peticiones. Antes se rechaza, como Java, el archivo
 * que pide más iteraciones de las que admite PKCS12KeyStore.
 */
async function load(p12: Buffer, password: string): Promise<{ keys: Bag[]; certs: Bag[] }> {
  if (maxIterationCount(p12) > MAX_ITERATION_COUNT) throw unreadable();
  const result = await new Promise<WorkerResult>((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: { p12, password } });
    worker.once('message', (message: WorkerResult) => {
      resolve(message);
      void worker.terminate();
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`El lector de PKCS#12 terminó con el código ${code}`));
    });
  }).catch((): WorkerResult => ({ ok: false }));
  // Contraseña errónea y archivo corrupto no se distinguen: el mensaje no da pistas de cuál fue.
  if (!result.ok) throw unreadable();
  return result;
}

/** El certificado de una clave: el que comparte su localKeyId (o, si no lo hay, su friendlyName). */
function certificateOf(key: Bag, certs: Bag[]): Bag | undefined {
  if (key.localKeyId !== null) return certs.find((c) => c.localKeyId === key.localKeyId);
  return key.friendlyName === null ? undefined : certs.find((c) => c.friendlyName === key.friendlyName);
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
export async function inspectPkcs12(p12: Buffer, password: string, now: Date): Promise<SigningMaterial> {
  const { keys, certs } = await load(p12, password);
  const withKey: SigningMaterial[] = [];
  try {
    for (const key of keys) {
      const cert = certificateOf(key, certs);
      if (cert === undefined) continue;
      const certificateDer = Buffer.from(cert.der);
      withKey.push({
        privateKey: createPrivateKey({ key: Buffer.from(key.der), format: 'der', type: 'pkcs8' }),
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
