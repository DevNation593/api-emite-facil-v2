/**
 * Valida un XML contra el XSD de un comprobante en una versión. Nunca lanza por el contenido del XML
 * (un XML ilegible, un DOCTYPE o un error de esquema son un `ValidationResult` inválido), pero sí cuando
 * falla el motor: un plazo vencido o un worker caído no dicen nada del XML, así que son un error
 * interno y no un XML inválido. Rechaza cualquier DOCTYPE antes de pasarlo a libxml2 (docs/10-security.md). Port de xml/XsdValidator.java,
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
 * Devuelve los errores como `<mensaje> (línea N)`. Un fallo del motor que no es de validación
 * (el worker se cae, memoria agotada) lanza un `Error`, no un resultado inválido.
 */
export async function validateWithSchema(
  xml: Buffer,
  main: SchemaFile,
  preload: readonly SchemaFile[],
): Promise<ValidationResult> {
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
      errors.length > 0 ? errors : [result.rawOutput.trim() || 'XML no válido'],
  };
}

/** Validaciones simultáneas como máximo: cada una crea un Worker de hasta 256 MiB. */
export const MAX_CONCURRENT_VALIDATIONS = 4;
/** Plazo de una validación; pasado, lanza un error y se libera su turno. */
export const VALIDATION_TIMEOUT_MS = 10_000;

export type SchemaEngine = (
  xml: Buffer,
  main: SchemaFile,
  preload: readonly SchemaFile[],
) => Promise<ValidationResult>;

export interface XsdValidatorOptions {
  /** Motor de validación; por defecto libxml2. Se inyecta en las pruebas. */
  readonly engine?: SchemaEngine;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
}

export class XsdValidator {
  private readonly engine: SchemaEngine;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly files = new Map<string, Promise<string>>();

  constructor(options: XsdValidatorOptions = {}) {
    this.engine = options.engine ?? validateWithSchema;
    this.timeoutMs = options.timeoutMs ?? VALIDATION_TIMEOUT_MS;
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_VALIDATIONS;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    // El turno pasa directamente al primero de la cola (FIFO): `active` no baja ni sube.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  /**
   * Corre el motor con turno y plazo. xmllint-wasm no expone el Worker, así que no se puede terminar uno
   * colgado: al vencer el plazo (o al fallar el motor) se libera el turno y se lanza un `Error`; el Worker
   * queda a lo que haga, sin forma de cancelarlo desde aquí.
   */
  private async runLimited(
    xml: Buffer,
    main: SchemaFile,
    preload: readonly SchemaFile[],
  ): Promise<ValidationResult> {
    await this.acquire();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `La validación XSD no terminó en ${this.timeoutMs / 1000} s`,
              ),
            ),
          this.timeoutMs,
        );
      });
      const run = this.engine(xml, main, preload).catch(
        (error: unknown): never => {
          const detail = error instanceof Error ? error.message.trim() : '';
          throw new Error(detail || 'No se pudo validar el XML', {
            cause: error,
          });
        },
      );
      return await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
      this.release();
    }
  }

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

  /** El límite de 320 KB del envío lo aplica DocumentXmlCheck, no este validador. */
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
    return this.runLimited(xml, { fileName: 'schema.xsd', contents: xsd }, [
      { fileName: XMLDSIG_NAME, contents: xmldsig },
      EMPTY_DTD,
    ]);
  }
}
