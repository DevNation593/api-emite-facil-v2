/**
 * Lector XML seguro sobre `saxes`: con espacios de nombres, sin resolver entidades (solo las cinco
 * predefinidas y las numéricas), sin abrir archivos ni red, y con rechazo de cualquier DOCTYPE
 * (docs/10-security.md). Equivale al `XMLReader` de Java con `disallow-doctype-decl`.
 */
import { SaxesParser } from 'saxes';

/** Un DOCTYPE: no se admite en ningún XML de comprobante. */
export class XmlRejectedError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'XmlRejectedError';
  }
}

/** XML mal formado o con una entidad no predefinida. `message` es el mensaje de saxes sin posición. */
export class XmlMalformedError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'XmlMalformedError';
  }
}

export interface XmlHandler {
  /** Los atributos van por `{uri}local`; los `xmlns*` no se informan, como en SAX. */
  open?(
    uri: string,
    local: string,
    attributes: ReadonlyMap<string, string>,
  ): void;
  text?(text: string): void;
  close?(uri: string, local: string): void;
}

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/** Clave de un atributo en el mapa de `open`. */
export function attributeKey(uri: string, local: string): string {
  return `{${uri}}${local}`;
}

export function readXml(xml: Buffer, handler: XmlHandler): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(xml);
  } catch {
    throw new XmlMalformedError('secuencia de bytes UTF-8 no válida', 1);
  }

  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', (error) => {
    throw new XmlMalformedError(
      error.message.replace(/^(?:[^:\n]*:)?\d+:\d+:\s*/, ''),
      parser.line,
    );
  });
  parser.on('doctype', () => {
    throw new XmlRejectedError('DOCTYPE no permitido', parser.line);
  });
  parser.on('opentag', (tag) => {
    const attributes = new Map<string, string>();
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === XMLNS_NS) continue;
      attributes.set(
        attributeKey(attribute.uri, attribute.local),
        attribute.value,
      );
    }
    handler.open?.(tag.uri, tag.local, attributes);
  });
  parser.on('closetag', (tag) => handler.close?.(tag.uri, tag.local));
  parser.on('text', (value) => handler.text?.(value));
  parser.on('cdata', (value) => handler.text?.(value));

  parser.write(text).close();
}
