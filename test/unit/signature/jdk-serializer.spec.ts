import { DOMImplementation } from '@xmldom/xmldom';
import { serializeLikeJdk } from '../../../src/signature/jdk-serializer.js';
import { parseSigned } from '../../../src/signature/xades-profile.js';

// Lo que el golden serializacion-jdk no cubre porque sale de un XML leído: nodos creados por código, sin sus
// declaraciones. Los resultados esperados son los del Transformer del JDK de XadesBesSigner.serialize sobre el
// mismo DOM construido con Xerces (sondeo con Java 25 y -Dline.separator=\n).
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const XML = 'http://www.w3.org/XML/1998/namespace';
const text = (document: Parameters<typeof serializeLikeJdk>[0]) => serializeLikeJdk(document).toString('utf8');

it('declara los espacios de nombres que faltan: el del atributo antes de él y el del elemento al final', () => {
  const document = new DOMImplementation().createDocument(null, 'r');
  const root = document.documentElement!;
  const x = document.createElementNS('urn:a', 'a:x');
  x.setAttribute('z', '1');
  x.setAttributeNS('urn:b', 'b:y', '2');
  x.setAttribute('b', '3');
  root.appendChild(x);
  x.appendChild(document.createElementNS('urn:a', 'a:c'));
  const e = document.createElementNS('urn:e', 'e:c');
  e.setAttributeNS(XMLNS, 'xmlns:e', 'urn:e');
  e.setAttributeNS(XMLNS, 'xmlns:a', 'urn:a');
  x.appendChild(e);
  root.appendChild(document.createTextNode('x]]>y'));
  // xmldom no crea un CDATA con ]]>, pero su dato se puede cambiar después.
  const cdata = document.createCDATASection('p');
  root.appendChild(cdata);
  cdata.data = 'p]]>q';

  expect(text(document)).toBe(
    '<?xml version="1.0" encoding="UTF-8"?><r><a:x b="3" xmlns:b="urn:b" b:y="2" z="1" xmlns:a="urn:a">' +
      '<a:c/><e:c xmlns:e="urn:e"/></a:x>x]]&gt;y<![CDATA[p]]]]><![CDATA[>q]]></r>',
  );
});

it('anula el espacio de nombres predeterminado, no declara xml: y escribe las instrucciones de proceso', () => {
  const document = new DOMImplementation().createDocument('urn:d', 'r');
  const root = document.documentElement!;
  root.appendChild(document.createElementNS(null, 'plain'));
  const p = document.createElementNS('urn:p', 'p:x');
  p.setAttributeNS(XML, 'xml:lang', 'es');
  root.appendChild(p);
  root.appendChild(document.createProcessingInstruction('empty', ''));
  root.appendChild(document.createProcessingInstruction('sp', ' lead'));

  expect(text(document)).toBe(
    '<?xml version="1.0" encoding="UTF-8"?><r xmlns="urn:d"><plain xmlns=""/><p:x xml:lang="es" xmlns:p="urn:p"/>' +
      '<?empty?><?sp lead?></r>',
  );
});

it('parseSigned normaliza los finales de línea como XML 1.0: U+0085 y U+2028 no son saltos', () => {
  const nel = String.fromCodePoint(0x85);
  const lsep = String.fromCodePoint(0x2028);
  const document = parseSigned(Buffer.from(`<a>x\r\ny\rz${nel}w${lsep}v</a>`, 'utf8'));
  expect(document.documentElement!.textContent).toBe(`x\ny\nz${nel}w${lsep}v`);
  expect(text(document)).toBe(`<?xml version="1.0" encoding="UTF-8"?><a>x\ny\nz&#133;w${lsep}v</a>`);
});
