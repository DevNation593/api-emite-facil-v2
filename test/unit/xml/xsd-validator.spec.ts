import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DOCUMENT_SCHEMAS,
  XMLDSIG_FILE,
  sampleFile,
  type DocumentSchema,
} from '../../../src/xml/document-type.js';
import {
  validateWithSchema,
  XsdValidator,
  type SchemaFile,
} from '../../../src/xml/xsd-validator.js';

// Traducción de InvoiceXsdIT, DocumentSamplesXsdIT y ClasspathSchemaResolverTest.rejectsEverythingElse.
const readFileSpy = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  readFileSpy.mockImplementation(original.readFile);
  return { ...original, readFile: readFileSpy };
});

const validator = new XsdValidator();
const standard = readFileSync(
  new URL('../../golden/xades/factura-estandar/unsigned.xml', import.meta.url),
);
const utf8 = (text: string) => Buffer.from(text, 'utf8');
const sample = (schema: DocumentSchema) => readFileSync(sampleFile(schema));

describe('ejemplos oficiales del SRI', () => {
  it.each(['INVOICE_1_0_0', 'INVOICE_1_1_0', 'INVOICE_2_1_0'] as const)(
    'el ejemplo de %s valida',
    async (name) => {
      const result = await validator.validate(
        sample(DOCUMENT_SCHEMAS[name]),
        DOCUMENT_SCHEMAS[name],
      );
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    },
  );

  it('el ejemplo 2.0.0 falla por el incoTermFactura vacío', async () => {
    const result = await validator.validate(
      sample(DOCUMENT_SCHEMAS.INVOICE_2_0_0),
      DOCUMENT_SCHEMAS.INVOICE_2_0_0,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('incoTermFactura'))).toBe(true);
  });

  it.each(
    Object.values(DOCUMENT_SCHEMAS)
      .filter((s) => s.type.name !== 'INVOICE')
      .map((s) => [s.name, s] as const),
  )('el ejemplo de %s valida', async (_name, schema) => {
    const result = await validator.validate(sample(schema), schema);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('contenido', () => {
  it('la factura estándar valida contra 1.1.0', async () => {
    expect(
      await validator.validate(standard, DOCUMENT_SCHEMAS.INVOICE_1_1_0),
    ).toEqual({ valid: true, errors: [] });
  });

  it('un error de esquema se informa como "mensaje (línea N)"', async () => {
    const broken = utf8(
      standard.toString('utf8').replaceAll('razonSocial>', 'razonSocialX>'),
    );
    const result = await validator.validate(
      broken,
      DOCUMENT_SCHEMAS.INVOICE_1_1_0,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    for (const error of result.errors) expect(error).toMatch(/ \(línea \d+\)$/);
  });

  it('rechaza un DOCTYPE sin leer la entidad externa', async () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE factura [<!ENTITY x SYSTEM "file:///etc/passwd">]>' +
      '<factura id="comprobante" version="1.0.0">&x;</factura>';
    const result = await validator.validate(
      utf8(xml),
      DOCUMENT_SCHEMAS.INVOICE_1_0_0,
    );
    expect(result).toEqual({
      valid: false,
      errors: ['DOCTYPE no permitido (línea 1)'],
    });
  });

  it('un XML ilegible o vacío es inválido, no una excepción', async () => {
    const unclosed = await validator.validate(
      utf8('<factura'),
      DOCUMENT_SCHEMAS.INVOICE_1_0_0,
    );
    expect(unclosed.valid).toBe(false);
    expect(unclosed.errors[0]).toMatch(/ \(línea \d+\)$/);
    const empty = await validator.validate(
      Buffer.alloc(0),
      DOCUMENT_SCHEMAS.INVOICE_1_0_0,
    );
    expect(empty.valid).toBe(false);
    expect(empty.errors.length).toBeGreaterThan(0);
    const badBytes = await validator.validate(
      Buffer.from([0x3c, 0xff, 0xfe]),
      DOCUMENT_SCHEMAS.INVOICE_1_0_0,
    );
    expect(badBytes.valid).toBe(false);
  });

  it('una entidad no predefinida es inválida', async () => {
    const result = await validator.validate(
      utf8('<factura>&x;</factura>'),
      DOCUMENT_SCHEMAS.INVOICE_1_0_0,
    );
    expect(result.valid).toBe(false);
  });

  it('lee cada XSD del disco una sola vez', async () => {
    const fresh = new XsdValidator();
    readFileSpy.mockClear();
    await fresh.validate(standard, DOCUMENT_SCHEMAS.INVOICE_1_1_0);
    await fresh.validate(standard, DOCUMENT_SCHEMAS.INVOICE_1_1_0);
    await Promise.all([
      fresh.validate(standard, DOCUMENT_SCHEMAS.INVOICE_1_1_0),
      fresh.validate(standard, DOCUMENT_SCHEMAS.INVOICE_1_1_0),
    ]);
    // El XSD de la factura y el XMLDSig compartido.
    expect(readFileSpy).toHaveBeenCalledTimes(2);
  });
});

describe('plazo y simultaneidad', () => {
  const ok = { valid: true, errors: [] };

  it('nunca hay más de 4 validaciones a la vez y se atienden en orden', async () => {
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const releases: (() => void)[] = [];
    const engine = (xml: Buffer) => {
      started.push(xml.length);
      running++;
      peak = Math.max(peak, running);
      return new Promise<typeof ok>((resolve) =>
        releases.push(() => {
          running--;
          resolve(ok);
        }),
      );
    };
    const limited = new XsdValidator({ engine });
    const all = Array.from({ length: 10 }, (_, i) =>
      limited.validate(
        Buffer.from(`<a>${'x'.repeat(i)}</a>`),
        DOCUMENT_SCHEMAS.INVOICE_1_1_0,
      ),
    );
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(started).toHaveLength(4);
    for (let done = 0; done < 10; done++) {
      releases[done]!();
      await tick();
      expect(running).toBeLessThanOrEqual(4);
    }
    expect((await Promise.all(all)).every((r) => r.valid)).toBe(true);
    expect(peak).toBe(4);
    expect(started).toEqual([...started].sort((a, b) => a - b)); // FIFO: llegaron con longitud creciente
  });

  it('una validación que no termina lanza el error de plazo y libera el turno', async () => {
    const limited = new XsdValidator({
      engine: () => new Promise(() => {}),
      timeoutMs: 30,
      maxConcurrent: 1,
    });
    await expect(
      limited.validate(standard, DOCUMENT_SCHEMAS.INVOICE_1_1_0),
    ).rejects.toThrow('La validación XSD no terminó en 0.03 s');
    // El turno quedó libre: la siguiente también responde, no se queda esperando.
    await expect(
      limited.validate(standard, DOCUMENT_SCHEMAS.INVOICE_1_1_0),
    ).rejects.toThrow('La validación XSD no terminó');
  });

  it('un motor que rechaza lanza un error, no un XML inválido, y libera el turno', async () => {
    const limited = new XsdValidator({
      engine: () => Promise.reject(new Error('worker caído')),
      maxConcurrent: 1,
    });
    await expect(
      limited.validate(standard, DOCUMENT_SCHEMAS.INVOICE_1_1_0),
    ).rejects.toThrow('worker caído');
    await expect(
      limited.validate(standard, DOCUMENT_SCHEMAS.INVOICE_1_1_0),
    ).rejects.toThrow('worker caído');
  });

  it('el contenido inválido sigue siendo un resultado, no una excepción', async () => {
    const limited = new XsdValidator({ maxConcurrent: 1 });
    const doctype = Buffer.from('<!DOCTYPE a [<!ENTITY e "x">]><a/>');
    expect((await limited.validate(doctype, DOCUMENT_SCHEMAS.INVOICE_1_1_0)).valid).toBe(false);
    expect((await limited.validate(Buffer.from('<a/>'), DOCUMENT_SCHEMAS.INVOICE_1_1_0)).valid).toBe(false);
  });
});

describe('lista cerrada de recursos de esquema', () => {
  let server: Server;
  let hits: string[] = [];
  let base = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      hits.push(request.url ?? '');
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    hits = [];
  });

  const instance =
    '<x:root xmlns:x="urn:x"><y:thing xmlns:y="urn:ext"/></x:root>';
  const schemaImporting = (location: string, prologue = '') =>
    `<?xml version="1.0"?>${prologue}<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:x="urn:x" xmlns:y="urn:ext" targetNamespace="urn:x" elementFormDefault="qualified">` +
    `<xsd:import namespace="urn:ext" schemaLocation="${location}"/>` +
    '<xsd:element name="root"><xsd:complexType><xsd:sequence><xsd:element ref="y:thing"/></xsd:sequence></xsd:complexType></xsd:element></xsd:schema>';
  // Un XSD que no compila hace fallar al motor (rechaza); aquí cuenta igual que «no valida».
  const run = (xsd: string, preload: SchemaFile[] = []) =>
    validateWithSchema(
      utf8(instance),
      { fileName: 'schema.xsd', contents: xsd },
      preload,
    ).catch((error: unknown) => ({
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    }));

  it('un import de http no valida y no abre conexiones', async () => {
    const result = await run(schemaImporting(`${base}/x.xsd`));
    expect(result.valid).toBe(false);
    expect(hits).toEqual([]);
  });

  it('un import de http://example.invalid no valida', async () => {
    expect(
      (await run(schemaImporting('http://example.invalid/x.xsd'))).valid,
    ).toBe(false);
  });

  it('un archivo fuera del sistema virtual no se lee, ni por ruta absoluta ni relativa', async () => {
    const external =
      '<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:ext" elementFormDefault="qualified"><xsd:element name="thing"/></xsd:schema>';
    expect(readFileSync(XMLDSIG_FILE).length).toBeGreaterThan(0);
    for (const location of [
      XMLDSIG_FILE.replaceAll('\\', '/'),
      '../../package.json',
      'otro.xsd',
      '/etc/passwd',
    ]) {
      expect((await run(schemaImporting(location))).valid, location).toBe(
        false,
      );
    }
    // Con el archivo en el sistema virtual el mismo XSD sí valida: lo único que cambia es la lista cerrada.
    const allowed = await run(schemaImporting('ext.xsd'), [
      { fileName: 'ext.xsd', contents: external },
    ]);
    expect(allowed).toEqual({ valid: true, errors: [] });
  });

  it('un DTD externo en el XSD no abre conexiones', async () => {
    const result = await run(
      schemaImporting(
        `${base}/x.xsd`,
        `<!DOCTYPE xsd:schema SYSTEM "${base}/externo.dtd">`,
      ),
    );
    expect(result.valid).toBe(false);
    expect(hits).toEqual([]);
  });
});

describe.runIf(process.env.XSD_BENCH === '1')(
  'rendimiento (XSD_BENCH=1)',
  () => {
    it('200 validaciones seguidas de factura-estandar: p95 < 100 ms', async () => {
      await validator.validate(standard, DOCUMENT_SCHEMAS.INVOICE_1_1_0); // calentamiento
      const times: number[] = [];
      for (let i = 0; i < 200; i++) {
        const start = performance.now();
        const result = await validator.validate(
          standard,
          DOCUMENT_SCHEMAS.INVOICE_1_1_0,
        );
        times.push(performance.now() - start);
        expect(result.valid).toBe(true);
      }
      times.sort((a, b) => a - b);
      const p50 = times[Math.floor(times.length * 0.5)]!;
      const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
      console.log(
        `XSD_BENCH p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms max=${times.at(-1)!.toFixed(1)} ms`,
      );
      expect(p95).toBeLessThan(100);
    }, 120_000);
  },
);
