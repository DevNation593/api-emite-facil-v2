import type { Attr, CharacterData, Document, Element, Node, ProcessingInstruction } from '@xmldom/xmldom';

/*
 * Escribe un documento como el Transformer de identidad del JDK que usa XadesBesSigner.serialize
 * (UTF-8, sin sangría, standalone): XadesBesSigner reescribe el documento ENTERO, no solo añade la
 * firma, así que el XML firmado depende de estas reglas. Salen del golden xades/serializacion-jdk y de
 * los comprobantes firmados con Java (tools/golden-generator, familia xades):
 *
 * - Declaración `<?xml version="1.0" encoding="UTF-8"?>`, sin `standalone` y sin salto de línea; nada
 *   entre los nodos del nivel del documento.
 * - Atributos ordenados por nombre calificado (Xerces los guarda así), con las declaraciones `xmlns*`
 *   delante. Una declaración que repite la que ya está en vigor no se escribe; la que falta para un
 *   atributo con prefijo va justo antes de él, y la del propio elemento, al final.
 * - Elemento sin hijos: `<a/>`.
 * - Texto: `&amp;`, `&lt;`, `&gt;`, `\r` → `&#13;`, controles U+007F–U+009F y caracteres fuera del
 *   BMP como referencia decimal; las comillas, U+2028 y el resto, tal cual. El `\n` sale como el
 *   separador de línea del sistema, que en el Linux donde corre la API es `\n`.
 * - Atributos: `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#9;`, `&#10;`, `&#13;` y los caracteres fuera del
 *   BMP como referencia decimal; el apóstrofo y los controles C1, tal cual.
 * - CDATA, comentarios e instrucciones de proceso, tal cual (`]]>` parte el CDATA en dos).
 */

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;
const PROCESSING_INSTRUCTION = 7;
const COMMENT = 8;

type Scope = ReadonlyMap<string, string>;

const SPACE_CHAR = /^[\p{Zs}\p{Zl}\p{Zp}]/u;

function escapeText(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === '&') out += '&amp;';
    else if (char === '<') out += '&lt;';
    else if (char === '>') out += '&gt;';
    else if (char === '\r') out += '&#13;';
    else if ((code >= 0x7f && code <= 0x9f) || code > 0xffff) out += `&#${code};`;
    else out += char;
  }
  return out;
}

function escapeAttribute(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '&') out += '&amp;';
    else if (char === '<') out += '&lt;';
    else if (char === '>') out += '&gt;';
    else if (char === '"') out += '&quot;';
    else if (char === '\t' || char === '\n' || char === '\r' || code > 0xffff) out += `&#${code};`;
    else out += char;
  }
  return out;
}

const byName = (a: Attr, b: Attr) => (a.nodeName < b.nodeName ? -1 : a.nodeName > b.nodeName ? 1 : 0);
const isDeclaration = (attr: Attr) => attr.nodeName === 'xmlns' || attr.nodeName.startsWith('xmlns:');

function writeElement(element: Element, parentScope: Scope, out: string[]): void {
  const scope = new Map(parentScope);
  out.push('<', element.nodeName);
  const declare = (prefix: string, uri: string) => {
    if (scope.get(prefix) === uri) return;
    scope.set(prefix, uri);
    out.push(prefix === '' ? ' xmlns="' : ` xmlns:${prefix}="`, escapeAttribute(uri), '"');
  };

  const attributes = Array.from(element.attributes).sort(byName);
  for (const attr of attributes) {
    if (isDeclaration(attr)) declare(attr.nodeName === 'xmlns' ? '' : attr.nodeName.slice(6), attr.value);
  }
  for (const attr of attributes) {
    if (isDeclaration(attr)) continue;
    const uri = attr.namespaceURI;
    if (uri && uri !== XMLNS_NS && attr.prefix) declare(attr.prefix, uri);
    out.push(' ', attr.nodeName, '="', escapeAttribute(attr.value), '"');
  }
  // Un elemento sin espacio de nombres anula el predeterminado heredado con xmlns="".
  declare(element.namespaceURI ? (element.prefix ?? '') : '', element.namespaceURI ?? '');

  if (element.firstChild === null) {
    out.push('/>');
    return;
  }
  out.push('>');
  for (let child: Node | null = element.firstChild; child !== null; child = child.nextSibling) writeNode(child, scope, out);
  out.push('</', element.nodeName, '>');
}

function writeNode(node: Node, scope: Scope, out: string[]): void {
  switch (node.nodeType) {
    case ELEMENT:
      writeElement(node as Element, scope, out);
      return;
    case TEXT:
      out.push(escapeText((node as CharacterData).data));
      return;
    case CDATA:
      out.push('<![CDATA[', (node as CharacterData).data.replaceAll(']]>', ']]]]><![CDATA[>'), ']]>');
      return;
    case COMMENT:
      out.push('<!--', (node as CharacterData).data, '-->');
      return;
    case PROCESSING_INSTRUCTION: {
      const { target, data } = node as ProcessingInstruction;
      // Sin separador si los datos están vacíos o ya empiezan por un espacio (Character.isSpaceChar).
      out.push('<?', target, data === '' || SPACE_CHAR.test(data) ? '' : ' ', data, '?>');
      return;
    }
    default:
      throw new Error(`Nodo XML no admitido al serializar: tipo ${node.nodeType}`);
  }
}

/** El documento con los bytes que escribe el Transformer del JDK de XadesBesSigner.serialize. */
export function serializeLikeJdk(document: Document): Buffer {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const scope: Scope = new Map([
    ['xml', XML_NS],
    ['', ''],
  ]);
  for (let child = document.firstChild; child !== null; child = child.nextSibling) {
    // xmldom guarda la declaración XML como instrucción de proceso; Xerces no la tiene en el DOM, ni
    // admite texto fuera de la raíz.
    if (child.nodeType === PROCESSING_INSTRUCTION && (child as ProcessingInstruction).target === 'xml') continue;
    if (child.nodeType === TEXT) continue;
    writeNode(child, scope, out);
  }
  return Buffer.from(out.join(''), 'utf8');
}
