/**
 * Tipos de comprobante electrónico con XSD empacado (ficha técnica, tabla 3) y cada XSD en una versión
 * publicada por el SRI. Port de xml/DocumentType.java y xml/DocumentSchema.java.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DocumentType {
  /** Nombre del enum de Java. */
  readonly name: string;
  /** Código `codDoc` del SRI. */
  readonly code: string;
  /** Carpeta bajo `resources/xsd/`. */
  readonly folder: string;
  /** Prefijo con que el SRI nombra los archivos. */
  readonly filePrefix: string;
  /** Elemento raíz del XML del comprobante. */
  readonly rootElement: string;
  /** Elemento de información propia del tipo, hijo de la raíz. */
  readonly infoElement: string;
}

function type(
  name: string,
  code: string,
  folder: string,
  filePrefix: string,
  rootElement: string,
  infoElement: string,
): DocumentType {
  return Object.freeze({
    name,
    code,
    folder,
    filePrefix,
    rootElement,
    infoElement,
  });
}

const INVOICE = type(
  'INVOICE',
  '01',
  'invoice',
  'factura',
  'factura',
  'infoFactura',
);
const PURCHASE_LIQUIDATION = type(
  'PURCHASE_LIQUIDATION',
  '03',
  'liquidation',
  'LiquidacionCompra',
  'liquidacionCompra',
  'infoLiquidacionCompra',
);
const CREDIT_NOTE = type(
  'CREDIT_NOTE',
  '04',
  'credit-note',
  'NotaCredito',
  'notaCredito',
  'infoNotaCredito',
);
const DEBIT_NOTE = type(
  'DEBIT_NOTE',
  '05',
  'debit-note',
  'NotaDebito',
  'notaDebito',
  'infoNotaDebito',
);
const REMISSION_GUIDE = type(
  'REMISSION_GUIDE',
  '06',
  'remission-guide',
  'GuiaRemision',
  'guiaRemision',
  'infoGuiaRemision',
);
const RETENTION_RECEIPT = type(
  'RETENTION_RECEIPT',
  '07',
  'retention-receipt',
  'ComprobanteRetencion',
  'comprobanteRetencion',
  'infoCompRetencion',
);

export const DOCUMENT_TYPES = {
  INVOICE,
  PURCHASE_LIQUIDATION,
  CREDIT_NOTE,
  DEBIT_NOTE,
  REMISSION_GUIDE,
  RETENTION_RECEIPT,
} as const;

export function documentTypeOf(code: string): DocumentType {
  for (const candidate of Object.values(DOCUMENT_TYPES)) {
    if (candidate.code === code) return candidate;
  }
  throw new Error(`Tipo de comprobante desconocido: ${code}`);
}

export interface DocumentSchema {
  /** Nombre del enum de Java, por ejemplo `INVOICE_1_1_0`. */
  readonly name: string;
  readonly type: DocumentType;
  readonly version: string;
}

function schema(documentType: DocumentType, version: string): DocumentSchema {
  return Object.freeze({
    name: `${documentType.name}_${version.replaceAll('.', '_')}`,
    type: documentType,
    version,
  });
}

export const DOCUMENT_SCHEMAS = {
  INVOICE_1_0_0: schema(INVOICE, '1.0.0'),
  INVOICE_1_1_0: schema(INVOICE, '1.1.0'),
  INVOICE_2_0_0: schema(INVOICE, '2.0.0'),
  INVOICE_2_1_0: schema(INVOICE, '2.1.0'),
  PURCHASE_LIQUIDATION_1_0_0: schema(PURCHASE_LIQUIDATION, '1.0.0'),
  PURCHASE_LIQUIDATION_1_1_0: schema(PURCHASE_LIQUIDATION, '1.1.0'),
  CREDIT_NOTE_1_0_0: schema(CREDIT_NOTE, '1.0.0'),
  CREDIT_NOTE_1_1_0: schema(CREDIT_NOTE, '1.1.0'),
  DEBIT_NOTE_1_0_0: schema(DEBIT_NOTE, '1.0.0'),
  REMISSION_GUIDE_1_0_0: schema(REMISSION_GUIDE, '1.0.0'),
  REMISSION_GUIDE_1_1_0: schema(REMISSION_GUIDE, '1.1.0'),
  RETENTION_RECEIPT_1_0_0: schema(RETENTION_RECEIPT, '1.0.0'),
  RETENTION_RECEIPT_2_0_0: schema(RETENTION_RECEIPT, '2.0.0'),
} as const;

export function documentSchemaOf(
  documentType: DocumentType,
  version: string,
): DocumentSchema {
  for (const candidate of Object.values(DOCUMENT_SCHEMAS)) {
    if (
      candidate.type.name === documentType.name &&
      candidate.version === version
    )
      return candidate;
  }
  throw new Error(
    `Versión de esquema desconocida para ${documentType.name}: ${version}`,
  );
}

/**
 * Raíz de `resources/xsd/`. Desde `src/xml/` y desde `dist/xml/` (build con `rootDir: src`) son
 * dos niveles hasta la raíz del proyecto, donde viven `resources/` y, en la imagen, `/app/resources`.
 */
export const XSD_ROOT = fileURLToPath(
  new URL('../../resources/xsd/', import.meta.url),
);

/** XMLDSig compartido por todos los XSD del SRI. */
export const XMLDSIG_FILE = join(XSD_ROOT, 'common', 'xmldsig-core-schema.xsd');

function resourceDir(s: DocumentSchema): string {
  return join(XSD_ROOT, s.type.folder, s.version);
}

/** Ruta absoluta del XSD del esquema. */
export function xsdFile(s: DocumentSchema): string {
  return join(resourceDir(s), `${s.type.filePrefix}_V${s.version}.xsd`);
}

/** Ruta absoluta del XML de ejemplo del SRI para el esquema. */
export function sampleFile(s: DocumentSchema): string {
  return join(resourceDir(s), `${s.type.filePrefix}_V${s.version}.xml`);
}
