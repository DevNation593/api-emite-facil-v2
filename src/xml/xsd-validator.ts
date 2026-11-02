/**
 * Valida un XML contra el XSD de un comprobante en una versión. Nunca lanza por el contenido del XML
 * y rechaza cualquier DOCTYPE antes de pasarlo a libxml2 (docs/10-security.md). Port de xml/XsdValidator.java,
 * xml/DocumentSchemas.java y xml/ClasspathSchemaResolver.java.
 *
 * libxml2 (xmllint-wasm) corre en un worker con un sistema de archivos en memoria que solo contiene el XSD
 * del esquema, el XMLDSig compartido y un `XMLSchema.dtd` vacío: es la misma lista cerrada del resolver de
 * Java. No ve el disco ni la red, de modo que un `import` o un `schemaLocation` externo no se resuelve.
 */
import { readFile } from 'node:fs/promises';
import { validateXML } from 'xmllint-wasm';
import { XMLDSIG_FILE, xsdFile, type DocumentSchema } from './document-type.js';
import { readXml, XmlMalformedError, XmlRejectedError } from './secure-sax.js';

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
}

/** Archivo del sistema de archivos virtual de libxml2. */
export interface SchemaFile {
  readonly fileName: string;
  readonly contents: string | Uint8Array;
}

const XMLDSIG_NAME = 'xmldsig-core-schema.xsd';
/** El DTD que declara xmldsig-core-schema.xsd: su subconjunto interno ya trae lo necesario. */
const EMPTY_DTD: SchemaFile = { fileName: 'XMLSchema.dtd', contents: '' };
/** Un XML de comprobante no pasa de 320 KB; el margen cubre cualquier otro llamador. */
const MAX_MEMORY_PAGES = 4096; // 256 MiB en páginas de 64 KiB

/**
 * Valida con libxml2 contra `main`, con solo `preload` en el sistema de archivos virtual.
 * Devuelve los errores como `<mensaje> (línea N)`. Un fallo de libxml2 que no es de validación
 * (XSD que no compila, memoria agotada) también se informa como error, nunca como excepción.
 */
export async function validateWithSchema(
  xml: Buffer,
  main: SchemaFile,
  preload: readonly SchemaFile[],
): Promise<ValidationResult> {
  try {
    const result = await validateXML({
      xml: { fileName: 'comprobante.xml', contents: new Uint8Array(xml) },
      schema: main,
      preload: [...preload],
      maxMemoryPages: MAX_MEMORY_PAGES,
    });
    if (result.valid) return { valid: true, errors: [] };
    const errors = result.errors.map((error) =>
      error.loc
        ? `${error.message} (línea ${error.loc.lineNumber})`
        : error.message,
    );
    return {
      valid: false,
      errors:
        errors.length > 0
          ? errors
          : [result.rawOutput.trim() || 'XML no válido'],
    };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.trim() : String(error);
    return { valid: false, errors: [detail || 'No se pudo validar el XML'] };
  }
}

export class XsdValidator {
  private readonly files = new Map<string, Promise<string>>();

  /** Lee cada archivo del disco una sola vez. */
  private load(path: string): Promise<string> {
    let content = this.files.get(path);
    if (!content) {
      content = readFile(path, 'utf8');
      // Un fallo de lectura no se queda en caché: el siguiente intento vuelve a leer.
      content.catch(() => this.files.delete(path));
      this.files.set(path, content);
    }
    return content;
  }

  async validate(
    xml: Buffer,
    schema: DocumentSchema,
  ): Promise<ValidationResult> {
    try {
      readXml(xml, {});
    } catch (error) {
      if (error instanceof XmlRejectedError) {
        return {
          valid: false,
          errors: [`DOCTYPE no permitido (línea ${error.line})`],
        };
      }
      if (error instanceof XmlMalformedError) {
        return {
          valid: false,
          errors: [`${error.message} (línea ${error.line})`],
        };
      }
      throw error;
    }
    const [xsd, xmldsig] = await Promise.all([
      this.load(xsdFile(schema)),
      this.load(XMLDSIG_FILE),
    ]);
    return validateWithSchema(xml, { fileName: 'schema.xsd', contents: xsd }, [
      { fileName: XMLDSIG_NAME, contents: xmldsig },
      EMPTY_DTD,
    ]);
  }
}
