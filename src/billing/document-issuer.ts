import { type Kysely, sql, type Transaction } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import type { ErrorCode } from '../common/error-codes.js';
import { setDocumentId } from '../common/request-context.js';
import type { CustomerView } from '../catalog/customer.service.js';
import type { AuditLog } from '../compliance/audit-log.js';
import { REDELIVERY_LEASE_MS } from '../config/app-config.js';
import type { DB } from '../database/schema.js';
import { AccessKeyParts } from '../sequence/access-key-parts.js';
import { fiscalDateOf } from '../sequence/fiscal-clock.js';
import { nextNumericCode } from '../sequence/numeric-code.js';
import type { SequenceService } from '../sequence/sequence.service.js';
import type { TaxpayerRow, TaxpayerService } from '../taxpayer/taxpayer.service.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';
import { NORMAL_EMISSION, XmlCharacterError } from '../xml/xml-writer.js';
import type { DocumentEnvelope, ModifiedDocument, Recipient, Totals } from './document-envelope.js';
import type { DocumentKind } from './document-kind.js';
import type { DocumentXmlCheck } from './document-xml-check.js';
import type { FiscalDocumentRepository } from './fiscal-document.repository.js';
import type { IdempotencyStore } from './idempotency-store.js';
import type { OutboxWriter } from './outbox-writer.js';

export const STATE_RESERVED = 'RESERVED';

/** Evento del outbox de todo comprobante reservado; lo recoge la cola de emisión. */
export const EVENT_RESERVED = 'DOCUMENT_RESERVED';

const CURRENCY = 'USD';

/** Largo máximo del detalle de un XML inválido, como el motivo de XSD_INVALID. */
const MAX_PROBLEM_LENGTH = 500;

/**
 * Lo común de la petición de emisión. `issueDate` (YYYY-MM-DD) y `currency` pueden ser nulos (hoy y
 * USD); `replacesDocumentId`, nulo si no es una reemisión.
 */
export interface IssueRequest {
  taxpayerId: string;
  establishmentCode: string;
  emissionPointCode: string;
  issueDate: string | null;
  currency: string | null;
  replacesDocumentId: string | null;
}

/** Lo que el tipo necesita saber para preparar su parte: el emisor y la fecha de emisión ya resuelta. */
export interface IssueContext {
  taxpayer: TaxpayerRow;
  issueDate: string;
}

/**
 * La parte del tipo, ya validada: el receptor (su fila del catálogo de clientes y proveedores y los
 * datos que el comprobante congela de él), los totales (o nulo), el documento modificado (o nulo) y su
 * contenido propio. Los datos del receptor pueden no ser los del catálogo de hoy: una nota copia los de
 * su factura.
 */
export interface Preparation<C> {
  kind: DocumentKind<C>;
  customerId: string;
  recipient: Recipient;
  totals: Totals | null;
  modified: ModifiedDocument | null;
  content: C;
}

/** Los datos que el comprobante congela de un cliente del catálogo. */
export function recipientOf(customer: CustomerView): Recipient {
  return {
    idType: customer.idType,
    idNumber: customer.idNumber,
    name: customer.name,
    address: customer.address,
    email: customer.email,
    phone: customer.phone,
  };
}

interface EmissionPointRef {
  id: string;
  enabled: boolean;
  establishmentAddress: string;
}

const unprocessable = (errorCode: ErrorCode, detail: string) => new ApiException(422, errorCode, detail);

function xmlInvalid(problem: string | null): ApiException {
  const detail = problem ?? 'El XML del comprobante no es válido';
  return unprocessable(
    'DOCUMENT_XML_INVALID',
    detail.length > MAX_PROBLEM_LENGTH ? detail.slice(0, MAX_PROBLEM_LENGTH) : detail,
  );
}

/** `LocalDate.isAfter` sobre el texto de un LocalDate de Java, que puede llevar signo y más de cuatro cifras de año. */
function isAfter(date: string, other: string): boolean {
  const parts = (text: string) => {
    const match = /^([+-]?\d+)-(\d{2})-(\d{2})$/.exec(text);
    if (match === null) throw new Error(`Fecha inválida: ${text}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  };
  const [y1, m1, d1] = parts(date);
  const [y2, m2, d2] = parts(other);
  return y1 !== y2 ? y1 > y2 : m1 !== m2 ? m1 > m2 : d1 > d2;
}

/**
 * Emisión de un comprobante de cualquier tipo hasta el estado RESERVED: lo que no depende del tipo
 * (billing/DocumentIssuer.java). Todo ocurre en una transacción: si algo falla, incluido el XML, no
 * queda documento, ni secuencial consumido, ni evento por publicar, y la clave de idempotencia queda
 * libre. Las validaciones de la petición van antes de reservar el secuencial; el XML solo puede armarse
 * con el secuencial real, así que se genera y valida después de reservarlo, con la fila del contador
 * bloqueada hasta confirmar o revertir. Cada lectura va por la transacción abierta: con el pool lleno,
 * una emisión nunca espera una segunda conexión.
 */
export class DocumentIssuer {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly taxpayers: TaxpayerService,
    private readonly sequences: SequenceService,
    private readonly documents: FiscalDocumentRepository,
    private readonly xmlCheck: DocumentXmlCheck,
    private readonly outbox: OutboxWriter,
    private readonly audit: AuditLog,
    private readonly idempotency: IdempotencyStore,
    /** RUC del proveedor del sistema de facturación (ficha, Anexo 26); nulo si no está configurado. */
    private readonly providerRuc: string | null,
    /** Reloj de la fecha fiscal de hoy; las pruebas lo fijan para probar el cambio de día. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Emite el comprobante, o devuelve el ya emitido si la clave de idempotencia se repite con la misma
   * petición. `prepare` valida y arma la parte propia del tipo; corre dentro de la transacción, antes de
   * reservar el secuencial, y debe leer por la `trx` que recibe. El XML se genera y valida con el
   * secuencial y la clave reales: si no es válido responde 422 DOCUMENT_XML_INVALID y la transacción se
   * revierte.
   */
  async issue<C>(
    access: TenantAccess,
    idempotencyKey: string,
    requestHash: string,
    request: IssueRequest,
    prepare: (trx: Transaction<DB>, context: IssueContext) => Promise<Preparation<C>>,
  ): Promise<string> {
    access.requireBilling();
    const documentId = await this.db.transaction().execute(async (trx) => {
      const previous = await this.idempotency.begin(trx, access.tenantId, idempotencyKey, requestHash);
      if (previous !== null) return previous;
      // request.replacesDocumentId (la reemisión) todavía no se atiende: llega con la Task 9.
      const taxpayer = await this.taxpayers.findForTenant(trx, access.tenantId, request.taxpayerId);
      if (taxpayer === null) throw ApiException.notFound();
      const point = await this.emissionPoint(trx, access.tenantId, taxpayer.id, request);
      if (!point.enabled) throw unprocessable('EMISSION_POINT_DISABLED', 'El punto de emisión está deshabilitado');
      const currency = request.currency ?? CURRENCY;
      if (currency !== CURRENCY) throw unprocessable('UNSUPPORTED_CURRENCY', 'Solo se emiten comprobantes en USD');
      const today = fiscalDateOf(this.now());
      const issueDate = request.issueDate ?? today;
      if (isAfter(issueDate, today)) {
        throw unprocessable('INVALID_ISSUE_DATE', 'La fecha de emisión no puede ser futura');
      }

      const preparation = await prepare(trx, { taxpayer, issueDate });
      const kind = preparation.kind;

      const environment = taxpayer.default_environment;
      const documentType = kind.type.code;
      const sequence = await this.sequences.reserve(
        trx,
        access.tenantId,
        point.id,
        environment,
        documentType,
        issueDate,
      );
      const accessKey = new AccessKeyParts({
        issueDate,
        documentType,
        ruc: taxpayer.ruc,
        environment,
        establishment: request.establishmentCode,
        emissionPoint: request.emissionPointCode,
        sequence,
        numericCode: nextNumericCode(),
        emissionType: NORMAL_EMISSION,
      }).toAccessKey();
      const envelope: DocumentEnvelope = {
        type: kind.type,
        environment,
        issuer: {
          legalName: taxpayer.legal_name,
          tradeName: taxpayer.trade_name,
          ruc: taxpayer.ruc,
          headOfficeAddress: taxpayer.head_office_address,
          establishmentAddress: point.establishmentAddress,
          accountingRequired: taxpayer.accounting_required,
          specialTaxpayerCode: taxpayer.special_taxpayer_code,
          withholdingAgentCode: taxpayer.withholding_agent_code,
          rimpeRegime: taxpayer.rimpe_regime,
          phone: taxpayer.phone,
        },
        accessKey,
        establishmentCode: request.establishmentCode,
        emissionPointCode: request.emissionPointCode,
        sequence,
        issueDate,
        recipient: preparation.recipient,
        totals: preparation.totals,
        modified: preparation.modified,
        providerRuc: this.providerRuc,
      };
      const contentJson = kind.contentJson(preparation.content);
      // Se valida el contenido como el worker lo leerá, no el objeto en memoria.
      await this.requireValidXml(
        kind,
        envelope,
        contentJson === null ? preparation.content : kind.reloaded(preparation.content),
      );

      const id = await this.documents.insert(trx, {
        tenantId: access.tenantId,
        taxpayerId: taxpayer.id,
        emissionPointId: point.id,
        customerId: preparation.customerId,
        state: STATE_RESERVED,
        createdBy: access.userId,
        envelope,
        contentJson,
      });
      await kind.saveDetails(trx, access.tenantId, id, preparation.content);
      await this.documents.recordStateChange(trx, access.tenantId, id, null, STATE_RESERVED, null);
      await this.audit.recordFor(trx, access, kind.auditReserved, 'FISCAL_DOCUMENT', id, { sequence, environment });
      await this.outbox.write(trx, access.tenantId, id, EVENT_RESERVED, { documentId: id });
      // Red de seguridad: si ese evento se pierde o nadie logra procesarlo, el planificador retoma el documento.
      await this.documents.schedule(trx, access.tenantId, id, REDELIVERY_LEASE_MS, 0);
      await this.idempotency.complete(trx, access.tenantId, idempotencyKey, id);
      return id;
    });
    // Después de confirmar: un log de una emisión revertida no debe nombrar un comprobante que no existe.
    setDocumentId(documentId);
    return documentId;
  }

  /**
   * El XML que el worker generará después desde lo guardado: si no cumple su XSD y las reglas del sobre,
   * no se emite. No se guarda; el worker lo vuelve a generar igual.
   */
  private async requireValidXml<C>(kind: DocumentKind<C>, envelope: DocumentEnvelope, content: C): Promise<void> {
    let xml: Buffer;
    try {
      xml = kind.buildXml(envelope, content);
    } catch (error) {
      // Un dato que el XML no admite (un carácter de control, un régimen desconocido).
      if (error instanceof XmlCharacterError) throw xmlInvalid(error.message);
      throw error;
    }
    const problem = await this.xmlCheck.problem(xml, kind.schema);
    if (problem !== null) throw xmlInvalid(problem);
  }

  /** El punto de emisión se localiza por los códigos del comprobante, siempre dentro del emisor y del tenant. */
  private async emissionPoint(
    trx: Transaction<DB>,
    tenantId: string,
    taxpayerId: string,
    request: IssueRequest,
  ): Promise<EmissionPointRef> {
    const result = await sql<{ id: string; enabled: boolean; establishment_address: string }>`
      SELECT ep.id, ep.enabled, e.address AS establishment_address
      FROM emission_points ep JOIN establishments e ON e.id = ep.establishment_id
      WHERE e.tenant_id = ${tenantId} AND e.taxpayer_id = ${taxpayerId}
        AND e.code = ${request.establishmentCode} AND ep.code = ${request.emissionPointCode}`.execute(trx);
    const row = result.rows[0];
    if (row === undefined) throw ApiException.notFound();
    return { id: row.id, enabled: row.enabled, establishmentAddress: row.establishment_address };
  }
}
