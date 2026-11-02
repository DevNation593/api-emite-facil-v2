import forge from 'node-forge';

/**
 * El tope de iteraciones de PKCS12KeyStore de Java (MAX_ITERATION_COUNT). Por encima, Java rechaza
 * el archivo sin derivar ninguna clave ("MAC iteration count too large"); aquí igual, porque derivar
 * 2^31 iteraciones ocuparía horas.
 */
export const MAX_ITERATION_COUNT = 5_000_000;

const PBES2 = '1.2.840.113549.1.5.13';
const PBKDF2 = '1.2.840.113549.1.5.12';
// pbeWithSHAAnd… de PKCS#12 (RC4, 3DES, 2DES, RC2).
const PKCS12_PBE = /^1\.2\.840\.113549\.1\.12\.1\.\d+$/;
const DATA = '1.2.840.113549.1.7.1';

type Node = forge.asn1.Asn1;

const children = (node: Node | undefined): Node[] => (Array.isArray(node?.value) ? node.value : []);

function oid(node: Node | undefined): string | null {
  return node?.type === forge.asn1.Type.OID && typeof node.value === 'string' ? forge.asn1.derToOid(node.value) : null;
}

/** El contenido de un OCTET STRING, también si viene construido en trozos (BER). */
function octetBytes(node: Node): string {
  return typeof node.value === 'string' ? node.value : children(node).map(octetBytes).join('');
}

function integer(node: Node | undefined): bigint {
  if (node?.type !== forge.asn1.Type.INTEGER || typeof node.value !== 'string') return 0n;
  return BigInt(`0x${Buffer.from(node.value, 'binary').toString('hex') || '0'}`);
}

/** El mayor contador de iteraciones que pide el archivo; Infinity si no se puede leer. */
export function maxIterationCount(p12: Buffer): number {
  let max = 0n;
  const note = (count: bigint) => {
    if (count > max) max = count;
  };
  const walk = (node: Node, depth: number): void => {
    if (depth > 64) return;
    const parts = children(node);
    const algorithm = oid(parts[0]);
    if (algorithm === PBES2) {
      // PBES2-params: { keyDerivationFunc { PBKDF2, { salt, iterationCount, … } }, encryptionScheme }
      const kdf = children(parts[1])[0];
      if (oid(children(kdf)[0]) === PBKDF2) note(integer(children(children(kdf)[1])[1]));
    } else if (algorithm !== null && PKCS12_PBE.test(algorithm)) {
      // pkcs-12PbeParams: { salt, iterations }
      note(integer(children(parts[1])[1]));
    } else if (algorithm === DATA && parts[1]?.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC) {
      // ContentInfo de datos ({ data, [0] OCTET STRING }): lleva DER (AuthenticatedSafe o
      // SafeContents). EncryptedContentInfo también empieza por el OID de datos, pero sigue con un
      // AlgorithmIdentifier y se recorre como cualquier otro nodo.
      const octets = children(parts[1])[0];
      if (octets !== undefined) walk(forge.asn1.fromDer(octetBytes(octets)), depth + 1);
      return;
    }
    for (const child of parts) walk(child, depth + 1);
  };
  try {
    const pfx = forge.asn1.fromDer(p12.toString('binary'));
    const [, authSafe, macData] = children(pfx);
    // MacData: { DigestInfo, macSalt, iterations DEFAULT 1 }
    if (macData !== undefined) note(integer(children(macData)[2]));
    if (authSafe !== undefined) walk(authSafe, 0);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return max > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(max);
}
