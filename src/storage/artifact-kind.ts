/** Tipos de artefacto que se conservan de un comprobante, como storage/ArtifactKind.java. */
export type ArtifactKind =
  | 'XML_UNSIGNED'
  | 'XML_SIGNED'
  /** Respuesta del SRI que autorizó el comprobante, tal como llegó. */
  | 'SRI_AUTHORIZATION'
  /** XML autorizado que se entrega al receptor: datos de la autorización y el comprobante firmado. */
  | 'XML_AUTHORIZED'
  /** Representación impresa del comprobante (RIDE), en PDF. */
  | 'RIDE_PDF';

const KINDS: Record<ArtifactKind, { pathName: string; mediaType: string }> = {
  XML_UNSIGNED: { pathName: 'xml-unsigned', mediaType: 'application/xml' },
  XML_SIGNED: { pathName: 'xml-signed', mediaType: 'application/xml' },
  SRI_AUTHORIZATION: { pathName: 'sri-authorization', mediaType: 'application/xml' },
  XML_AUTHORIZED: { pathName: 'xml-authorized', mediaType: 'application/xml' },
  RIDE_PDF: { pathName: 'ride', mediaType: 'application/pdf' },
};

/** Nombre con el que aparece en la ruta de descarga. */
export function pathNameOf(kind: ArtifactKind): string {
  return KINDS[kind].pathName;
}

/** Tipo de contenido con el que se descarga. */
export function mediaTypeOf(kind: ArtifactKind): string {
  return KINDS[kind].mediaType;
}

export function artifactKindOf(pathName: string): ArtifactKind | null {
  const found = (Object.keys(KINDS) as ArtifactKind[]).find((kind) => KINDS[kind].pathName === pathName);
  return found ?? null;
}
