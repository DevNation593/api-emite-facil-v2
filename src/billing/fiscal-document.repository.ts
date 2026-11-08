import { type Kysely, sql, type Transaction } from 'kysely';
import { BigDecimal } from '../common/big-decimal.js';
import { isoInstant } from '../common/java-time.js';
import type { DB } from '../database/schema.js';
import { documentTypeOf } from '../xml/document-type.js';
import type { TaxTotal } from './invoice-calculator.js';
import type { DocumentEnvelope } from './document-envelope.js';

// Port de billing/FiscalDocumentRepository.java. Toda consulta filtra por `tenant_id`; las escrituras
// exigen una transacción abierta (Propagation.MANDATORY en Java no aplica a todas, pero una escritura
// del ciclo de vida del comprobante nunca debe confirmarse sola).

type Db = Kysely<DB> | Transaction<DB>;

/**
 * Sobre de un comprobante nuevo, tal como se generó y validó su XML. `contentJson` es el contenido
 * propio del tipo para la columna `content`; nulo en la factura.
 */
export interface NewDocument {
  tenantId: string;
  taxpayerId: string;
  emissionPointId: string;
  customerId: string;
  state: string;
  createdBy: string;
  envelope: DocumentEnvelope;
  contentJson: string | null;
}

export interface NewLine {
  productId: string | null;
  mainCode: string;
  description: string;
  quantity: BigDecimal;
  unitPrice: BigDecimal;
  discount: BigDecimal;
  subtotal: BigDecimal;
  taxCode: string;
  taxRateCode: string;
  taxRate: BigDecimal;
  taxAmount: BigDecimal;
}

/** `term` y `timeUnit` (plazo y unidadTiempo del XML) van juntos o ambos nulos. */
export interface NewPayment {
  methodCode: string;
  amount: BigDecimal;
  term: BigDecimal | null;
  timeUnit: string | null;
}

/** Cuerpo de la factura: sus líneas, los impuestos por tarifa y los pagos. */
export interface InvoiceBody {
  lines: NewLine[];
  taxes: TaxTotal[];
  payments: NewPayment[];
}

export interface DocumentRow {
  id: string;
  taxpayerId: string;
  documentType: string;
  state: string;
  environment: string;
  establishmentCode: string;
  emissionPointCode: string;
  sequence: number;
  accessKey: string;
  issueDate: string;
  currency: string;
  customerIdType: string;
  customerIdNumber: string;
  customerName: string;
  subtotal: BigDecimal | null;
  totalDiscount: BigDecimal | null;
  totalTax: BigDecimal | null;
  total: BigDecimal | null;
  authorizationNumber: string | null;
  /** ISO_INSTANT como lo escribe Jackson. */
  authorizedAt: string | null;
}

export interface LineRow {
  lineNo: number;
  mainCode: string;
  description: string;
  quantity: BigDecimal;
  unitPrice: BigDecimal;
  discount: BigDecimal;
  subtotal: BigDecimal;
  taxCode: string;
  taxRateCode: string;
  taxRate: BigDecimal;
  taxAmount: BigDecimal;
  productId: string | null;
}

export interface PaymentRow {
  lineNo: number;
  methodCode: string;
  amount: BigDecimal;
  term: BigDecimal | null;
  timeUnit: string | null;
}

/** A quién se emitió y con qué otros comprobantes está enlazado por una reemisión. */
export interface Links {
  customerId: string;
  replacesDocumentId: string | null;
  replacedByDocumentId: string | null;
}

/** Lo que el procesamiento necesita saber del documento. `version` cambia con cada transición. */
export interface ProcessingState {
  state: string;
  taxpayerId: string;
  documentType: string;
  environment: string;
  accessKey: string;
  attemptCount: number;
  version: number;
}

const DOCUMENT_COLUMNS =
  sql.raw(`id, taxpayer_id, document_type, state, environment, establishment_code,
  emission_point_code, sequence, access_key, issue_date, currency, customer_id_type, customer_id_number,
  customer_name, subtotal, total_discount, total_tax, total, authorization_number,
  to_char(authorized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS authorized_at`);

const ENVELOPE_COLUMNS =
  sql.raw(`document_type, environment, issuer_legal_name, issuer_trade_name, issuer_ruc,
  issuer_head_office_address, establishment_address, issuer_accounting_required,
  issuer_special_taxpayer_code, issuer_withholding_agent_code, issuer_rimpe_regime, access_key,
  establishment_code, emission_point_code, sequence, issue_date, customer_id_type, customer_id_number,
  customer_name, customer_address, customer_email, subtotal, total_discount, total_tax, total,
  modified_document_id, modified_doc_code, modified_doc_number, modified_doc_date, provider_ruc,
  issuer_phone, customer_phone`);

const PROCESSING_COLUMNS = sql.raw(
  'state, taxpayer_id, document_type, environment, access_key, attempt_count, version',
);

interface DocumentSqlRow {
  id: string;
  taxpayer_id: string;
  document_type: string;
  state: string;
  environment: string;
  establishment_code: string;
  emission_point_code: string;
  sequence: number;
  access_key: string;
  issue_date: string;
  currency: string;
  customer_id_type: string;
  customer_id_number: string;
  customer_name: string;
  subtotal: string | null;
  total_discount: string | null;
  total_tax: string | null;
  total: string | null;
  authorization_number: string | null;
  authorized_at: string | null;
}

interface EnvelopeSqlRow {
  document_type: string;
  environment: string;
  issuer_legal_name: string;
  issuer_trade_name: string | null;
  issuer_ruc: string;
  issuer_head_office_address: string;
  establishment_address: string;
  issuer_accounting_required: boolean;
  issuer_special_taxpayer_code: string | null;
  issuer_withholding_agent_code: string | null;
  issuer_rimpe_regime: string;
  access_key: string;
  establishment_code: string;
  emission_point_code: string;
  sequence: number;
  issue_date: string;
  customer_id_type: string;
  customer_id_number: string;
  customer_name: string;
  customer_address: string | null;
  customer_email: string | null;
  subtotal: string | null;
  total_discount: string | null;
  total_tax: string | null;
  total: string | null;
  modified_document_id: string | null;
  modified_doc_code: string | null;
  modified_doc_number: string | null;
  modified_doc_date: string | null;
  provider_ruc: string | null;
  issuer_phone: string | null;
  customer_phone: string | null;
}

/** El `numeric` llega como texto de `pg` con la escala de la columna, igual que JDBC. */
const dec = (text: string): BigDecimal => BigDecimal.of(text);
const decOrNull = (text: string | null): BigDecimal | null =>
  text === null ? null : dec(text);
/** Parámetro `numeric`: el texto con su escala. */
const num = (value: BigDecimal | null): string | null =>
  value === null ? null : value.toString();

function documentRow(row: DocumentSqlRow): DocumentRow {
  return {
    id: row.id,
    taxpayerId: row.taxpayer_id,
    documentType: row.document_type,
    state: row.state,
    environment: row.environment,
    establishmentCode: row.establishment_code,
    emissionPointCode: row.emission_point_code,
    sequence: row.sequence,
    accessKey: row.access_key,
    issueDate: row.issue_date,
    currency: row.currency,
    customerIdType: row.customer_id_type,
    customerIdNumber: row.customer_id_number,
    customerName: row.customer_name,
    subtotal: decOrNull(row.subtotal),
    totalDiscount: decOrNull(row.total_discount),
    totalTax: decOrNull(row.total_tax),
    total: decOrNull(row.total),
    authorizationNumber: row.authorization_number,
    authorizedAt:
      row.authorized_at === null ? null : isoInstant(row.authorized_at),
  };
}

function envelopeOf(row: EnvelopeSqlRow): DocumentEnvelope {
  return {
    type: documentTypeOf(row.document_type),
    environment: row.environment,
    issuer: {
      legalName: row.issuer_legal_name,
      tradeName: row.issuer_trade_name,
      ruc: row.issuer_ruc,
      headOfficeAddress: row.issuer_head_office_address,
      establishmentAddress: row.establishment_address,
      accountingRequired: row.issuer_accounting_required,
      specialTaxpayerCode: row.issuer_special_taxpayer_code,
      withholdingAgentCode: row.issuer_withholding_agent_code,
      rimpeRegime: row.issuer_rimpe_regime,
      phone: row.issuer_phone,
    },
    accessKey: row.access_key,
    establishmentCode: row.establishment_code,
    emissionPointCode: row.emission_point_code,
    sequence: row.sequence,
    issueDate: row.issue_date,
    recipient: {
      idType: row.customer_id_type,
      idNumber: row.customer_id_number,
      name: row.customer_name,
      address: row.customer_address,
      email: row.customer_email,
      phone: row.customer_phone,
    },
    totals:
      row.total === null
        ? null
        : {
            subtotal: decOrNull(row.subtotal),
            totalDiscount: decOrNull(row.total_discount),
            totalTax: decOrNull(row.total_tax),
            total: dec(row.total),
          },
    modified:
      row.modified_doc_code === null
        ? null
        : {
            documentId: row.modified_document_id,
            code: row.modified_doc_code,
            // Las tres columnas restantes del documento modificado van completas o ausentes (V11).
            number: row.modified_doc_number as string,
            issueDate: row.modified_doc_date as string,
          },
    providerRuc: row.provider_ruc,
  };
}

/** Una escritura que no va en una transacción podría confirmarse sin el resto del cambio. */
function requireTransaction(trx: Db): void {
  if (!trx.isTransaction) {
    throw new Error(
      'La escritura del comprobante exige una transacción abierta',
    );
  }
}

/** Lectura y escritura de documentos fiscales. Toda lectura filtra por tenant. */
export class FiscalDocumentRepository {
  /**
   * Inserta el sobre y devuelve el id. La moneda es siempre USD: la emisión no admite otra. Las tablas
   * propias del tipo (las de la factura) se llenan después, con `DocumentKind.saveDetails`.
   */
  async insert(trx: Transaction<DB>, document: NewDocument): Promise<string> {
    requireTransaction(trx);
    const envelope = document.envelope;
    const issuer = envelope.issuer;
    const recipient = envelope.recipient;
    const totals = envelope.totals;
    const modified = envelope.modified;
    const result = await sql<{ id: string }>`
      INSERT INTO fiscal_documents (tenant_id, taxpayer_id, emission_point_id, customer_id, document_type,
       environment, issuer_ruc, establishment_code, emission_point_code, sequence, access_key, state,
       issue_date, currency, customer_id_type, customer_id_number, customer_name, customer_address,
       customer_email, subtotal, total_discount, total_tax, total, created_by, issuer_legal_name,
       issuer_trade_name, issuer_head_office_address, establishment_address, issuer_accounting_required,
       issuer_special_taxpayer_code, issuer_withholding_agent_code, issuer_rimpe_regime, provider_ruc,
       modified_document_id, modified_doc_code, modified_doc_number, modified_doc_date, content,
       issuer_phone, customer_phone)
      VALUES (${document.tenantId}, ${document.taxpayerId}, ${document.emissionPointId}, ${document.customerId},
       ${envelope.type.code}, ${envelope.environment}, ${issuer.ruc}, ${envelope.establishmentCode},
       ${envelope.emissionPointCode}, ${envelope.sequence}, ${envelope.accessKey}, ${document.state},
       ${envelope.issueDate}, 'USD', ${recipient.idType}, ${recipient.idNumber}, ${recipient.name},
       ${recipient.address}, ${recipient.email}, ${num(totals?.subtotal ?? null)},
       ${num(totals?.totalDiscount ?? null)}, ${num(totals?.totalTax ?? null)}, ${num(totals?.total ?? null)},
       ${document.createdBy}, ${issuer.legalName}, ${issuer.tradeName}, ${issuer.headOfficeAddress},
       ${issuer.establishmentAddress}, ${issuer.accountingRequired}, ${issuer.specialTaxpayerCode},
       ${issuer.withholdingAgentCode}, ${issuer.rimpeRegime}, ${envelope.providerRuc},
       ${modified?.documentId ?? null}, ${modified?.code ?? null}, ${modified?.number ?? null},
       ${modified?.issueDate ?? null}, CAST(${document.contentJson} AS jsonb),
       ${issuer.phone}, ${recipient.phone})
      RETURNING id`.execute(trx);
    return (result.rows[0] as { id: string }).id;
  }

  /** Líneas, impuestos por tarifa y pagos de una factura ya insertada; las líneas y los pagos se numeran desde 1. */
  async insertInvoiceBody(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
    body: InvoiceBody,
  ): Promise<void> {
    requireTransaction(trx);
    for (const [index, line] of body.lines.entries()) {
      await sql`
        INSERT INTO fiscal_document_lines (tenant_id, document_id, line_no, product_id, main_code,
         description, quantity, unit_price, discount, subtotal, tax_code, tax_rate_code, tax_rate, tax_amount)
        VALUES (${tenantId}, ${documentId}, ${index + 1}, ${line.productId}, ${line.mainCode},
         ${line.description}, ${num(line.quantity)}, ${num(line.unitPrice)}, ${num(line.discount)},
         ${num(line.subtotal)}, ${line.taxCode}, ${line.taxRateCode}, ${num(line.taxRate)},
         ${num(line.taxAmount)})`.execute(trx);
    }
    for (const tax of body.taxes) {
      await sql`
        INSERT INTO fiscal_document_taxes (tenant_id, document_id, tax_code, rate_code, rate, base, amount)
        VALUES (${tenantId}, ${documentId}, ${tax.taxCode}, ${tax.rateCode}, ${num(tax.rate)},
         ${num(tax.base)}, ${num(tax.amount)})`.execute(trx);
    }
    for (const [index, payment] of body.payments.entries()) {
      await sql`
        INSERT INTO fiscal_document_payments (tenant_id, document_id, line_no, method_code, amount, term,
         time_unit)
        VALUES (${tenantId}, ${documentId}, ${index + 1}, ${payment.methodCode}, ${num(payment.amount)},
         ${num(payment.term)}, ${payment.timeUnit})`.execute(trx);
    }
  }

  async recordStateChange(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
    previousState: string | null,
    newState: string,
    reason: string | null,
  ): Promise<void> {
    requireTransaction(trx);
    await sql`
      INSERT INTO state_events (tenant_id, document_id, previous_state, new_state, reason, event_time)
      VALUES (${tenantId}, ${documentId}, ${previousState}, ${newState}, ${reason}, clock_timestamp())`.execute(
      trx,
    );
  }

  /**
   * Bloquea el documento hasta el final de la transacción en curso y devuelve su estado: dos
   * procesos que lo tomen a la vez avanzan de uno en uno.
   */
  async lockForProcessing(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
  ): Promise<ProcessingState | null> {
    requireTransaction(trx);
    const result = await sql<{
      state: string;
      taxpayer_id: string;
      document_type: string;
      environment: string;
      access_key: string;
      attempt_count: number;
      version: string;
    }>`SELECT ${PROCESSING_COLUMNS} FROM fiscal_documents
      WHERE id = ${documentId} AND tenant_id = ${tenantId} FOR UPDATE`.execute(
      trx,
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      state: row.state,
      taxpayerId: row.taxpayer_id,
      documentType: row.document_type,
      environment: row.environment,
      accessKey: row.access_key,
      attemptCount: row.attempt_count,
      version: Number(row.version),
    };
  }

  /**
   * Programa el siguiente intento dentro del plazo indicado (nulo: nada programado) y deja la
   * cuenta de intentos no concluyentes. No es una transición: no cambia `version`.
   */
  async schedule(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
    delayMs: number | null,
    attemptCount: number,
  ): Promise<void> {
    requireTransaction(trx);
    const seconds = delayMs === null ? null : delayMs / 1000;
    await sql`
      UPDATE fiscal_documents
      SET next_attempt_at = now() + make_interval(secs => CAST(${seconds} AS double precision)),
       attempt_count = ${attemptCount}
      WHERE id = ${documentId} AND tenant_id = ${tenantId}`.execute(trx);
  }

  async find(
    db: Db,
    tenantId: string,
    id: string,
  ): Promise<DocumentRow | null> {
    const result =
      await sql<DocumentSqlRow>`SELECT ${DOCUMENT_COLUMNS} FROM fiscal_documents
      WHERE id = ${id} AND tenant_id = ${tenantId}`.execute(db);
    const row = result.rows[0];
    return row === undefined ? null : documentRow(row);
  }

  /** Sobre congelado del comprobante, de cualquier tipo; nulo si no existe en esa empresa. */
  async envelope(
    db: Db,
    tenantId: string,
    documentId: string,
  ): Promise<DocumentEnvelope | null> {
    const result =
      await sql<EnvelopeSqlRow>`SELECT ${ENVELOPE_COLUMNS} FROM fiscal_documents
      WHERE id = ${documentId} AND tenant_id = ${tenantId}`.execute(db);
    const row = result.rows[0];
    return row === undefined ? null : envelopeOf(row);
  }

  /** JSON del contenido propio del comprobante; nulo si no existe en esa empresa o no tiene (la factura). */
  async content(
    db: Db,
    tenantId: string,
    documentId: string,
  ): Promise<string | null> {
    const result = await sql<{
      content: string;
    }>`SELECT content::text AS content FROM fiscal_documents
      WHERE id = ${documentId} AND tenant_id = ${tenantId} AND content IS NOT NULL`.execute(
      db,
    );
    return result.rows[0]?.content ?? null;
  }

  /** Cuerpo de la factura: sus líneas, los impuestos por tarifa y los pagos, en su orden. */
  async invoiceBody(
    db: Db,
    tenantId: string,
    documentId: string,
  ): Promise<InvoiceBody> {
    const lines = (await this.lines(db, tenantId, documentId)).map(
      (line): NewLine => ({
        productId: line.productId,
        mainCode: line.mainCode,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount,
        subtotal: line.subtotal,
        taxCode: line.taxCode,
        taxRateCode: line.taxRateCode,
        taxRate: line.taxRate,
        taxAmount: line.taxAmount,
      }),
    );
    const payments = (await this.payments(db, tenantId, documentId)).map(
      (payment): NewPayment => ({
        methodCode: payment.methodCode,
        amount: payment.amount,
        term: payment.term,
        timeUnit: payment.timeUnit,
      }),
    );
    return {
      lines,
      taxes: await this.taxes(db, tenantId, documentId),
      payments,
    };
  }

  /** Página de comprobantes del tenant; `documentType` nulo trae todos los tipos. */
  async page(
    db: Db,
    tenantId: string,
    documentType: string | null,
    page: number,
    size: number,
  ): Promise<DocumentRow[]> {
    const result = await sql<DocumentSqlRow>`SELECT ${DOCUMENT_COLUMNS}
      FROM fiscal_documents
       WHERE tenant_id = ${tenantId} AND (CAST(${documentType} AS varchar) IS NULL OR document_type = ${documentType})
      ORDER BY created_at DESC, sequence DESC, id
      LIMIT ${size} OFFSET ${page * size}`.execute(db);
    return result.rows.map(documentRow);
  }

  async count(
    db: Db,
    tenantId: string,
    documentType: string | null,
  ): Promise<number> {
    const result = await sql<{
      count: string;
    }>`SELECT count(*) AS count FROM fiscal_documents
       WHERE tenant_id = ${tenantId} AND (CAST(${documentType} AS varchar) IS NULL OR document_type = ${documentType})`.execute(
      db,
    );
    return Number((result.rows[0] as { count: string }).count);
  }

  async links(db: Db, tenantId: string, documentId: string): Promise<Links> {
    const result = await sql<{
      customer_id: string;
      replaces_document_id: string | null;
      replaced_by_document_id: string | null;
    }>`SELECT d.customer_id, d.replaces_document_id,
             (SELECT r.id FROM fiscal_documents r
               WHERE r.tenant_id = d.tenant_id AND r.replaces_document_id = d.id) AS replaced_by_document_id
        FROM fiscal_documents d WHERE d.id = ${documentId} AND d.tenant_id = ${tenantId}`.execute(
      db,
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new Error(`El comprobante ${documentId} no existe en la empresa`);
    return {
      customerId: row.customer_id,
      replacesDocumentId: row.replaces_document_id,
      replacedByDocumentId: row.replaced_by_document_id,
    };
  }

  /** El comprobante que reemplazó a este, si lo hay. */
  async replacementOf(
    db: Db,
    tenantId: string,
    documentId: string,
  ): Promise<string | null> {
    const result = await sql<{ id: string }>`SELECT id FROM fiscal_documents
      WHERE tenant_id = ${tenantId} AND replaces_document_id = ${documentId}`.execute(
      db,
    );
    return result.rows[0]?.id ?? null;
  }

  /** Anota en el comprobante nuevo a cuál reemplaza. */
  async linkReplacement(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
    replacedId: string,
  ): Promise<void> {
    requireTransaction(trx);
    await sql`UPDATE fiscal_documents SET replaces_document_id = ${replacedId}
      WHERE id = ${documentId} AND tenant_id = ${tenantId}`.execute(trx);
  }

  /**
   * Suma del total de las notas de crédito vigentes que modifican esa factura; cero si no hay. Vigente es
   * todo estado menos los fallos sin vuelta atrás (RETURNED, NOT_AUTHORIZED y XSD_INVALID): una nota en
   * camino al SRI ya cuenta.
   */
  async creditedTotal(
    db: Db,
    tenantId: string,
    invoiceId: string,
  ): Promise<BigDecimal> {
    const result = await sql<{
      total: string;
    }>`SELECT COALESCE(SUM(total), 0) AS total FROM fiscal_documents
       WHERE tenant_id = ${tenantId} AND modified_document_id = ${invoiceId} AND document_type = '04'
         AND state NOT IN ('RETURNED', 'NOT_AUTHORIZED', 'XSD_INVALID')`.execute(
      db,
    );
    return dec((result.rows[0] as { total: string }).total);
  }

  async lines(
    db: Db,
    tenantId: string,
    documentId: string,
  ): Promise<LineRow[]> {
    const result = await sql<{
      line_no: number;
      main_code: string;
      description: string;
      quantity: string;
      unit_price: string;
      discount: string;
      subtotal: string;
      tax_code: string;
      tax_rate_code: string;
      tax_rate: string;
      tax_amount: string;
      product_id: string | null;
    }>`SELECT line_no, main_code, description, quantity, unit_price, discount, subtotal, tax_code,
       tax_rate_code, tax_rate, tax_amount, product_id
      FROM fiscal_document_lines WHERE document_id = ${documentId} AND tenant_id = ${tenantId} ORDER BY line_no`.execute(
      db,
    );
    return result.rows.map((row) => ({
      lineNo: row.line_no,
      mainCode: row.main_code,
      description: row.description,
      quantity: dec(row.quantity),
      unitPrice: dec(row.unit_price),
      discount: dec(row.discount),
      subtotal: dec(row.subtotal),
      taxCode: row.tax_code,
      taxRateCode: row.tax_rate_code,
      taxRate: dec(row.tax_rate),
      taxAmount: dec(row.tax_amount),
      productId: row.product_id,
    }));
  }

  async taxes(
    db: Db,
    tenantId: string,
    documentId: string,
  ): Promise<TaxTotal[]> {
    const result = await sql<{
      tax_code: string;
      rate_code: string;
      rate: string;
      base: string;
      amount: string;
    }>`SELECT tax_code, rate_code, rate, base, amount FROM fiscal_document_taxes
      WHERE document_id = ${documentId} AND tenant_id = ${tenantId}
      ORDER BY tax_code, CAST(rate_code AS integer)`.execute(db);
    return result.rows.map((row) => ({
      taxCode: row.tax_code,
      rateCode: row.rate_code,
      rate: dec(row.rate),
      base: dec(row.base),
      amount: dec(row.amount),
    }));
  }

  async payments(
    db: Db,
    tenantId: string,
    documentId: string,
  ): Promise<PaymentRow[]> {
    const result = await sql<{
      line_no: number;
      method_code: string;
      amount: string;
      term: string | null;
      time_unit: string | null;
    }>`SELECT line_no, method_code, amount, term, time_unit FROM fiscal_document_payments
      WHERE document_id = ${documentId} AND tenant_id = ${tenantId} ORDER BY line_no`.execute(
      db,
    );
    return result.rows.map((row) => ({
      lineNo: row.line_no,
      methodCode: row.method_code,
      amount: dec(row.amount),
      term: decOrNull(row.term),
      timeUnit: row.time_unit,
    }));
  }
}
