import { DateTime } from 'luxon';
import { buildAccessKey } from './access-key.js';

export interface AccessKeyFields {
  /** YYYY-MM-DD, como LocalDate. */
  issueDate: string;
  documentType: string;
  ruc: string;
  environment: string;
  establishment: string;
  emissionPoint: string;
  sequence: number;
  numericCode: string;
  emissionType: string;
}

function requireMatch(value: unknown, pattern: RegExp, name: string): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Valor inválido para ${name}: ${String(value)}`);
  }
}

/**
 * Componentes de la clave de acceso en el orden de la ficha técnica. Todo salvo el secuencial se
 * conserva como texto para no perder ceros iniciales.
 */
export class AccessKeyParts {
  private readonly fields: AccessKeyFields;
  private readonly date: DateTime;

  constructor(fields: AccessKeyFields) {
    const date =
      typeof fields.issueDate === 'string' ? DateTime.fromISO(fields.issueDate, { zone: 'utc' }) : null;
    if (date === null || !date.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(fields.issueDate)) {
      throw new Error('La fecha de emisión es obligatoria');
    }
    requireMatch(fields.documentType, /^[0-9]{2}$/, 'tipo de comprobante');
    requireMatch(fields.ruc, /^[0-9]{13}$/, 'RUC');
    requireMatch(fields.environment, /^[12]$/, 'ambiente');
    requireMatch(fields.establishment, /^[0-9]{3}$/, 'establecimiento');
    requireMatch(fields.emissionPoint, /^[0-9]{3}$/, 'punto de emisión');
    if (!Number.isInteger(fields.sequence) || fields.sequence < 1 || fields.sequence > 999_999_999) {
      throw new Error(`Secuencial fuera de rango: ${fields.sequence}`);
    }
    requireMatch(fields.numericCode, /^[0-9]{8}$/, 'código numérico');
    requireMatch(fields.emissionType, /^[0-9]$/, 'tipo de emisión');
    this.fields = { ...fields };
    this.date = date;
  }

  toBase48(): string {
    const f = this.fields;
    return (
      this.date.toFormat('ddMMyyyy') +
      f.documentType +
      f.ruc +
      f.environment +
      f.establishment +
      f.emissionPoint +
      String(f.sequence).padStart(9, '0') +
      f.numericCode +
      f.emissionType
    );
  }

  toAccessKey(): string {
    return buildAccessKey(this.toBase48());
  }
}
