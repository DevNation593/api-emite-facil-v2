import type { DocumentSchema } from '../xml/document-type.js';
import { checkEnvelope } from '../xml/envelope-rules.js';
import type { XsdValidator } from '../xml/xsd-validator.js';

/** Tamaño máximo de un comprobante en el envío individual al SRI (ficha técnica, sección 7). */
const MAX_XML_BYTES = 320 * 1024;

/** La comprobación completa del XML de un comprobante: tamaño de envío, XSD y reglas del sobre. */
export class DocumentXmlCheck {
  constructor(private readonly validator: XsdValidator) {}

  /** El problema del XML, o `null` si cumple su XSD, las reglas que el XSD no cubre y el tamaño máximo. */
  async problem(xml: Buffer, schema: DocumentSchema): Promise<string | null> {
    if (xml.length > MAX_XML_BYTES)
      return 'El XML supera el tamaño máximo de envío de 320 KB';
    const result = await this.validator.validate(xml, schema);
    if (!result.valid) return result.errors.join('; ');
    const violations = checkEnvelope(xml, schema);
    if (violations.size > 0) return [...violations].sort().join(', ');
    return null;
  }
}
