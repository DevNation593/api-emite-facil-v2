import {
  readXml,
  XmlMalformedError,
  XmlRejectedError,
} from '../../../src/xml/secure-sax.js';

// El lector seguro es la pieza P0 de docs/10-security.md: ningún DOCTYPE, ninguna entidad propia.
function read(xml: string | Buffer) {
  const events: string[] = [];
  const buffer = typeof xml === 'string' ? Buffer.from(xml, 'utf8') : xml;
  let error: unknown;
  try {
    readXml(buffer, {
      open: (_uri, local) => events.push(`open:${local}`),
      text: (text) => events.push(`text:${text}`),
      close: (_uri, local) => events.push(`close:${local}`),
    });
  } catch (caught) {
    error = caught;
  }
  return { events, error };
}

describe('DOCTYPE', () => {
  it.each([
    ['tras un BOM', '\uFEFF<!DOCTYPE a><a/>'],
    ['tras espacios', '  \n <!DOCTYPE a><a/>'],
    ['tras la declaración XML', '<?xml version="1.0"?>\n<!DOCTYPE a><a/>'],
    ['con subconjunto interno', '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'],
    [
      'con entidad de parámetro SYSTEM',
      '<!DOCTYPE a [<!ENTITY % p SYSTEM "http://127.0.0.1:9/x.dtd"> %p;]><a/>',
    ],
    [
      'con identificador SYSTEM',
      '<!DOCTYPE a SYSTEM "http://127.0.0.1:9/x.dtd"><a/>',
    ],
  ])('se rechaza %s', (_name, xml) => {
    const { events, error } = read(xml);
    expect(error).toBeInstanceOf(XmlRejectedError);
    expect((error as XmlRejectedError).line).toBeGreaterThanOrEqual(1);
    // Nada del contenido llega al manejador, y &x; nunca se expande.
    expect(events.filter((e) => !/^text:\s*$/.test(e))).toEqual([]);
  });

  it('en minúsculas no es un DOCTYPE válido: XML ilegible, sin eventos', () => {
    const { events, error } = read('<!doctype a><a/>');
    expect(error).toBeInstanceOf(XmlMalformedError);
    expect(events).toEqual([]);
  });

  it('el BOM como bytes también se rechaza', () => {
    const { error } = read(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('<!DOCTYPE a><a/>'),
      ]),
    );
    expect(error).toBeInstanceOf(XmlRejectedError);
  });

  it('tras la raíz no se admite: error y sin más eventos', () => {
    const { events, error } = read('<a/><!DOCTYPE a><b>texto</b>');
    expect(error).toBeInstanceOf(Error);
    expect(events).not.toContain('open:b');
    expect(events).not.toContain('text:texto');
  });

  it('dentro de la raíz no se admite: error y sin más eventos', () => {
    const { events, error } = read('<a><!DOCTYPE a><b>texto</b></a>');
    expect(error).toBeInstanceOf(Error);
    expect(events).toEqual(['open:a']);
  });
});

describe('entidades', () => {
  it('una entidad no predefinida sin DOCTYPE es XML ilegible', () => {
    const { events, error } = read('<a>&foo;</a>');
    expect(error).toBeInstanceOf(XmlMalformedError);
    expect(events.join('')).not.toContain('foo');
  });

  it('las numéricas y las predefinidas se resuelven', () => {
    const { events, error } = read('<a>&#65;&amp;</a>');
    expect(error).toBeUndefined();
    expect(
      events
        .filter((e) => e.startsWith('text:'))
        .map((e) => e.slice(5))
        .join(''),
    ).toBe('A&');
  });
});

describe('errores', () => {
  it('un XML sin cerrar es XmlMalformedError con línea', () => {
    const { error } = read('<a>\n<b>');
    expect(error).toBeInstanceOf(XmlMalformedError);
    expect((error as XmlMalformedError).line).toBeGreaterThanOrEqual(1);
  });

  it('tras un error no hay más eventos', () => {
    const { events, error } = read('<a><b></a><c>texto</c>');
    expect(error).toBeInstanceOf(XmlMalformedError);
    expect(events).not.toContain('open:c');
    expect(events).not.toContain('text:texto');
  });

  it('bytes que no son UTF-8 y un archivo vacío son XmlMalformedError', () => {
    expect(read(Buffer.from([0x3c, 0xff])).error).toBeInstanceOf(
      XmlMalformedError,
    );
    expect(read('').error).toBeInstanceOf(XmlMalformedError);
  });
});
