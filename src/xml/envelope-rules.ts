/**
 * Comprueba en cualquier comprobante (factura, liquidación, notas, guía o retención) lo que su XSD no
 * restringe: código de documento, versión, id, ausencia de schemaLocation y que la clave de acceso sea
 * válida y corresponda a los datos del comprobante. Se aplica a un XML que ya pasó `XsdValidator`.
 * Port de xml/EnvelopeRules.java y xml/EnvelopeViolation.java.
 */
import { buildAccessKey, isValidAccessKey } from '../sequence/access-key.js';
import {
  DOCUMENT_TYPES,
  type DocumentSchema,
  type DocumentType,
} from './document-type.js';
import {
  attributeKey,
  readXml,
  XmlMalformedError,
  XmlRejectedError,
} from './secure-sax.js';

export type EnvelopeViolation =
  /** El elemento raíz no es el del tipo de comprobante del esquema. */
  | 'ROOT_MISMATCH'
  | 'COD_DOC_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'ID_MISSING'
  | 'SCHEMA_LOCATION_PRESENT'
  /** claveAcceso ausente, de longitud distinta de 49 dígitos o con dígito verificador incorrecto. */
  | 'ACCESS_KEY_INVALID'
  /** claveAcceso bien formada pero que no corresponde a los datos del mismo comprobante. */
  | 'ACCESS_KEY_MISMATCH';

const ROOT_ID = 'comprobante';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const DATE = /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/;
const BASE48 = /^[0-9]{48}$/;

interface Envelope {
  root?: string;
  version?: string;
  id?: string;
  schemaLocationPresent: boolean;
  headers: Map<string, string>;
}

/** Recoge los atributos de la raíz y el texto de los elementos de cabecera, solo en su lugar exacto. */
function readEnvelope(xml: Buffer, infoElement: string): Envelope {
  const headerPaths = new Set([
    'infoTributaria/codDoc',
    'infoTributaria/claveAcceso',
    'infoTributaria/ruc',
    'infoTributaria/ambiente',
    'infoTributaria/estab',
    'infoTributaria/ptoEmi',
    'infoTributaria/secuencial',
    'infoTributaria/tipoEmision',
    `${infoElement}/fechaEmision`,
  ]);
  const envelope: Envelope = {
    schemaLocationPresent: false,
    headers: new Map(),
  };
  const path: string[] = [];
  let capturing: string | undefined;
  let text = '';

  readXml(xml, {
    open(uri, local, attributes) {
      // El XSD admite atributos xsi:* en cualquier elemento, no solo en la raíz.
      if (
        attributes.has(attributeKey(XSI, 'schemaLocation')) ||
        attributes.has(attributeKey(XSI, 'noNamespaceSchemaLocation'))
      ) {
        envelope.schemaLocationPresent = true;
      }
      if (path.length === 0) {
        envelope.root = local;
        envelope.version = attributes.get(attributeKey('', 'version'));
        envelope.id = attributes.get(attributeKey('', 'id'));
      } else if (path.length === 2 && uri === '') {
        const candidate = `${path[1]}/${local}`;
        if (headerPaths.has(candidate) && !envelope.headers.has(candidate)) {
          capturing = candidate;
          text = '';
        }
      }
      path.push(local);
    },
    text(value) {
      if (capturing !== undefined && path.length === 3) text += value;
    },
    close() {
      path.pop();
      if (capturing !== undefined && path.length === 2) {
        envelope.headers.set(capturing, text);
        capturing = undefined;
      }
    },
  });
  return envelope;
}

/**
 * Reconstruye la clave con los datos del comprobante y el código numérico de la clave declarada
 * (doc 06). Devuelve `undefined` si falta algún dato o la fecha no tiene el formato dd/mm/aaaa. La guía de
 * remisión no declara fecha de emisión en su XML: para ella se toman las 8 primeras cifras de la clave
 * declarada, de modo que solo se comprueba el resto de los componentes.
 */
function expectedAccessKey(
  envelope: Envelope,
  type: DocumentType,
  declared: string,
): string | undefined {
  const header = (name: string) => envelope.headers.get(name);
  let date = header(`${type.infoElement}/fechaEmision`);
  if (date === undefined && type === DOCUMENT_TYPES.REMISSION_GUIDE) {
    date = `${declared.slice(0, 2)}/${declared.slice(2, 4)}/${declared.slice(4, 8)}`;
  }
  const parts = [
    'codDoc',
    'ruc',
    'ambiente',
    'estab',
    'ptoEmi',
    'secuencial',
  ].map((name) => header(`infoTributaria/${name}`));
  const emissionType = header('infoTributaria/tipoEmision');
  if (date === undefined || !DATE.test(date) || emissionType === undefined)
    return undefined;
  let base = date.replaceAll('/', '');
  for (const part of parts) {
    if (part === undefined) return undefined;
    base += part;
  }
  base += declared.slice(39, 47) + emissionType;
  return BASE48.test(base) ? buildAccessKey(base) : undefined;
}

export function checkEnvelope(
  xml: Buffer,
  schema: DocumentSchema,
): Set<EnvelopeViolation> {
  const type = schema.type;
  let envelope: Envelope;
  try {
    envelope = readEnvelope(xml, type.infoElement);
  } catch (error) {
    if (
      error instanceof XmlRejectedError ||
      error instanceof XmlMalformedError
    ) {
      throw new Error(`XML de comprobante ilegible: ${error.message}`);
    }
    throw error;
  }

  const violations = new Set<EnvelopeViolation>();
  if (type.rootElement !== envelope.root) violations.add('ROOT_MISMATCH');
  if (type.code !== envelope.headers.get('infoTributaria/codDoc'))
    violations.add('COD_DOC_MISMATCH');
  if (schema.version !== envelope.version) violations.add('VERSION_MISMATCH');
  if (ROOT_ID !== envelope.id) violations.add('ID_MISSING');
  if (envelope.schemaLocationPresent) violations.add('SCHEMA_LOCATION_PRESENT');
  const accessKey = envelope.headers.get('infoTributaria/claveAcceso');
  if (accessKey === undefined || !isValidAccessKey(accessKey))
    violations.add('ACCESS_KEY_INVALID');
  else if (accessKey !== expectedAccessKey(envelope, type, accessKey))
    violations.add('ACCESS_KEY_MISMATCH');
  return violations;
}
