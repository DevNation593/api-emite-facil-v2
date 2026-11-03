/**
 * Escritor de XML compartido por los generadores de comprobantes (xml/XmlWriter.java): texto escapado,
 * sin espacios entre elementos, fechas `dd/MM/yyyy` y decimales con escala fija, de modo que los mismos
 * datos produzcan siempre los mismos bytes.
 */
import type { BigDecimal } from '../common/big-decimal.js';
import { strip } from '../common/java-text.js';

/** Tipo de emisión normal: el único del esquema off-line. */
export const NORMAL_EMISSION = '1';

export const CURRENCY = 'DOLAR';

/** `IllegalArgumentException` de Java: un carácter que XML 1.0 no admite o un régimen RIMPE desconocido. */
export class XmlCharacterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlCharacterError';
  }
}

/** Campos de `infoTributaria` comunes a todos los comprobantes. */
export interface InfoTributaria {
  environment: string;
  legalName: string;
  tradeName: string | null;
  ruc: string;
  accessKey: string;
  documentCode: string;
  establishmentCode: string;
  emissionPointCode: string;
  sequence: number;
  headOfficeAddress: string;
  withholdingAgentCode: string | null;
  rimpeRegime: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Hay valor si no es nulo ni solo espacios (`String.isBlank` de Java). */
export function present(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && strip(value) !== '';
}

/** Leyendas del Anexo 22 de la ficha técnica. */
export function rimpeLegend(regime: string): string | null {
  switch (regime) {
    case 'NONE':
      return null;
    case 'EMPRENDEDOR':
      return 'CONTRIBUYENTE RÉGIMEN RIMPE';
    case 'NEGOCIO_POPULAR':
      return 'CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE';
    default:
      throw new XmlCharacterError(`Régimen RIMPE desconocido: ${regime}`);
  }
}

/** Número con la escala dada, en notación plana y redondeo mitad hacia arriba. */
export function scaledText(value: BigDecimal, scale: number): string {
  return value.toFixed(scale);
}

/** Importe con dos decimales. */
export function moneyText(value: BigDecimal): string {
  return scaledText(value, 2);
}

function allowedInXml(c: number): boolean {
  return (
    c === 0x9 ||
    c === 0xa ||
    c === 0xd ||
    (c >= 0x20 && c <= 0xd7ff) ||
    (c >= 0xe000 && c <= 0xfffd) ||
    (c >= 0x10000 && c <= 0x10ffff)
  );
}

const ESCAPES = new Map<string, string>([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&apos;'],
]);

export class XmlWriter {
  private out = '<?xml version="1.0" encoding="UTF-8"?>';

  /** UTF-8, con la declaración inicial. */
  toBuffer(): Buffer {
    return Buffer.from(this.out, 'utf8');
  }

  /** Abre el elemento raíz con `id="comprobante"` y la versión del esquema. */
  openRoot(name: string, version: string): void {
    this.out += `<${name} id="comprobante" version="${version}">`;
  }

  /** `infoTributaria` común a todos los comprobantes (Anexo 22 para la leyenda RIMPE). */
  infoTributaria(fields: InfoTributaria): void {
    this.open('infoTributaria');
    this.element('ambiente', fields.environment);
    this.element('tipoEmision', NORMAL_EMISSION);
    this.element('razonSocial', fields.legalName);
    this.optional('nombreComercial', fields.tradeName);
    this.element('ruc', fields.ruc);
    this.element('claveAcceso', fields.accessKey);
    this.element('codDoc', fields.documentCode);
    this.element('estab', fields.establishmentCode);
    this.element('ptoEmi', fields.emissionPointCode);
    this.element('secuencial', String(fields.sequence).padStart(9, '0'));
    this.element('dirMatriz', fields.headOfficeAddress);
    this.optional('agenteRetencion', fields.withholdingAgentCode);
    this.optional('contribuyenteRimpe', rimpeLegend(fields.rimpeRegime));
    this.close('infoTributaria');
  }

  /** Ficha técnica v2.34, Anexo 26: RUC del proveedor del sistema de facturación. */
  providerInfo(ruc: string | null): void {
    if (present(ruc)) {
      this.open('infoAdicional');
      this.out += '<campoAdicional nombre="RUC Proveedor">';
      this.text(ruc);
      this.out += '</campoAdicional>';
      this.close('infoAdicional');
    }
  }

  open(name: string): void {
    this.out += `<${name}>`;
  }

  close(name: string): void {
    this.out += `</${name}>`;
  }

  element(name: string, value: string): void {
    this.open(name);
    this.text(value);
    this.close(name);
  }

  optional(name: string, value: string | null): void {
    if (present(value)) this.element(name, value);
  }

  /** Fecha `YYYY-MM-DD` escrita como `dd/MM/yyyy`. */
  date(name: string, isoDate: string): void {
    const match = ISO_DATE.exec(isoDate);
    if (match === null) throw new Error(`Fecha no válida: ${isoDate}`);
    this.element(name, `${match[3]}/${match[2]}/${match[1]}`);
  }

  /** Importe con dos decimales. */
  money(name: string, value: BigDecimal): void {
    this.element(name, moneyText(value));
  }

  /** Número con la escala dada (seis para cantidad y precio unitario). */
  scaled(name: string, value: BigDecimal, scale: number): void {
    this.element(name, scaledText(value, scale));
  }

  /** Escapa el texto y rechaza los caracteres que XML 1.0 no admite, un sustituto suelto incluido. */
  private text(value: string): void {
    let escaped = '';
    // for…of recorre puntos de código y entrega un sustituto suelto como su propio carácter.
    for (const ch of value) {
      const replacement = ESCAPES.get(ch);
      if (replacement !== undefined) {
        escaped += replacement;
        continue;
      }
      const c = ch.codePointAt(0) as number;
      if (!allowedInXml(c)) {
        throw new XmlCharacterError(
          `Carácter no admitido en XML: U+${c.toString(16)}`,
        );
      }
      escaped += ch;
    }
    this.out += escaped;
  }
}
