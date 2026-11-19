import { Logger } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { DocumentKind, DocumentKinds } from '../billing/document-kind.js';
import type { DocumentXmlCheck } from '../billing/document-xml-check.js';
import type { FiscalDocumentRepository } from '../billing/fiscal-document.repository.js';
import type { CertificateService } from '../certificate/certificate.service.js';
import { CertificateRejectedException, type SigningMaterial } from '../certificate/pkcs12-inspector.js';
import { SecretCipherException } from '../certificate/secret-cipher.js';
import { ApiException } from '../common/api-exception.js';
import type { DB } from '../database/schema.js';
import type { XadesVerifier } from '../signature/xades-verifier.js';
import { SignatureInputError, SigningError, type XadesBesSigner } from '../signature/xades-signer.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import { documentSchemaOf, type DocumentSchema } from '../xml/document-type.js';
import { XmlCharacterError } from '../xml/xml-writer.js';
import type { DocumentEnvelope } from '../billing/document-envelope.js';

/*
 * Lleva un comprobante de RESERVED a SIGNED, como orchestration/DocumentProcessor.java: genera el XML con la
 * pieza de su tipo, lo valida, lo firma y guarda ambos XML como artefactos. Es reentrante: se puede llamar de
 * nuevo sobre el mismo documento sin repetir trabajo ni duplicar artefactos, y reintenta la firma si antes no
 * fue posible.
 */

export const RESERVED = 'RESERVED';
export const GENERATED = 'GENERATED';
export const SIGNED = 'SIGNED';
export const XSD_INVALID = 'XSD_INVALID';
export const SIGNATURE_FAILED = 'SIGNATURE_FAILED';

/** Estados desde los que `generateAndSign` tiene trabajo pendiente. */
export const PENDING_STATES: readonly string[] = [RESERVED, GENERATED, SIGNATURE_FAILED];

const MAX_REASON_LENGTH = 500;

/** El contenido propio del comprobante no existe o no encaja en el tipo. */
class UnreadableContent extends Error {}

/** Un error de la base (SQLSTATE): no es contenido ilegible y debe revertir la transacción. */
const isDatabaseError = (error: unknown) =>
  typeof (error as { code?: unknown } | null)?.code === 'string' &&
  typeof (error as { severity?: unknown }).severity === 'string';

export class DocumentProcessor {
  private readonly logger = new Logger(DocumentProcessor.name);

  constructor(
    private readonly db: Kysely<DB>,
    private readonly documents: FiscalDocumentRepository,
    private readonly kinds: DocumentKinds,
    private readonly xmlCheck: DocumentXmlCheck,
    private readonly certificates: CertificateService,
    private readonly signer: XadesBesSigner,
    private readonly verifier: XadesVerifier,
    private readonly artifacts: ArtifactStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Devuelve el estado en que queda el documento. Una transacción, con el comprobante bloqueado. */
  generateAndSign(tenantId: string, documentId: string): Promise<string> {
    return this.db.transaction().execute(async (trx) => {
      const locked = await this.documents.lockForProcessing(trx, tenantId, documentId);
      if (locked === null) throw ApiException.notFound();
      let state = locked.state;
      if (state === RESERVED) state = await this.generate(trx, tenantId, documentId);
      if (state === GENERATED || state === SIGNATURE_FAILED) {
        state = await this.sign(trx, tenantId, documentId, locked.taxpayerId, state);
      }
      return state;
    });
  }

  private async generate(trx: Transaction<DB>, tenantId: string, documentId: string): Promise<string> {
    const envelope = await this.documents.envelope(trx, tenantId, documentId);
    if (envelope === null) throw ApiException.notFound();
    const kind = this.kinds.find(envelope.type.code);
    if (kind === null) return this.fail(trx, tenantId, documentId, RESERVED, XSD_INVALID, 'DOCUMENT_TYPE_NOT_SUPPORTED');
    let xml: Buffer;
    try {
      xml = await this.build(trx, kind, tenantId, documentId, envelope);
    } catch (error) {
      if (error instanceof UnreadableContent) {
        this.logger.error(
          `El contenido del documento ${documentId} no se pudo leer`,
          error.cause instanceof Error ? error.cause.stack : String(error.cause),
        );
        return this.fail(trx, tenantId, documentId, RESERVED, XSD_INVALID, 'CONTENT_UNREADABLE');
      }
      if (error instanceof XmlCharacterError) {
        return this.fail(trx, tenantId, documentId, RESERVED, XSD_INVALID, error.message);
      }
      throw error;
    }
    const problem = await this.xmlCheck.problem(xml, kind.schema);
    if (problem !== null) return this.fail(trx, tenantId, documentId, RESERVED, XSD_INVALID, problem);
    await this.artifacts.save(trx, tenantId, documentId, 'XML_UNSIGNED', xml);
    await this.documents.setSchemaVersion(trx, tenantId, documentId, kind.schema.version);
    await this.documents.transition(trx, tenantId, documentId, RESERVED, GENERATED, null);
    return GENERATED;
  }

  private async build(
    trx: Transaction<DB>,
    kind: DocumentKind<unknown>,
    tenantId: string,
    documentId: string,
    envelope: DocumentEnvelope,
  ): Promise<Buffer> {
    let content: unknown;
    try {
      content = await kind.loadContent(trx, tenantId, documentId);
    } catch (error) {
      // Un fallo de la base no es contenido ilegible: revierte la transacción.
      if (isDatabaseError(error)) throw error;
      throw new UnreadableContent('Contenido ilegible', { cause: error });
    }
    return kind.buildXml(envelope, content);
  }

  private async sign(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
    taxpayerId: string,
    from: string,
  ): Promise<string> {
    const unsigned = await this.artifacts.find(trx, tenantId, documentId, 'XML_UNSIGNED');
    if (unsigned === null) throw new Error(`Documento generado sin su XML: ${documentId}`);
    const now = this.now();
    // Ningún fallo de esta parte debe deshacer la generación ya hecha ni quedar sin registro: el documento
    // pasa a SIGNATURE_FAILED con su motivo y se puede reintentar.
    let signed: Buffer;
    try {
      // El .p12 se descifra y se lee en cada firma, como en Java: el material no se guarda en memoria.
      const material: SigningMaterial = await this.certificates.signingMaterial(tenantId, taxpayerId, now, trx);
      signed = this.signer.sign(unsigned.content, material, now);
    } catch (error) {
      if (error instanceof CertificateRejectedException) {
        return this.fail(trx, tenantId, documentId, from, SIGNATURE_FAILED, error.errorCode);
      }
      if (error instanceof SecretCipherException) {
        // Sin la causa: no hay nada del certificado ni de la clave que valga la pena registrar.
        this.logger.error(`El certificado guardado del emisor ${taxpayerId} no se pudo descifrar`);
        return this.fail(trx, tenantId, documentId, from, SIGNATURE_FAILED, 'CERTIFICATE_UNDECRYPTABLE');
      }
      if (error instanceof SignatureInputError || error instanceof SigningError) {
        this.logger.error(`No se pudo firmar el documento ${documentId}: ${error.message}`);
        return this.fail(trx, tenantId, documentId, from, SIGNATURE_FAILED, 'SIGNING_ERROR');
      }
      throw error;
    }
    // Nada se da por firmado sin comprobarlo: la firma debe verificar y el XML seguir siendo válido.
    const verification = this.verifier.verify(signed);
    if (!verification.valid || (await this.xmlCheck.problem(signed, await this.schemaOf(trx, tenantId, documentId))) !== null) {
      return this.fail(trx, tenantId, documentId, from, SIGNATURE_FAILED, 'SIGNATURE_NOT_VERIFIABLE');
    }
    await this.artifacts.save(trx, tenantId, documentId, 'XML_SIGNED', signed);
    await this.documents.transition(trx, tenantId, documentId, from, SIGNED, null);
    return SIGNED;
  }

  /** Esquema con que se generó el documento: su tipo y la versión guardada al generarlo. */
  private async schemaOf(trx: Transaction<DB>, tenantId: string, documentId: string): Promise<DocumentSchema> {
    const envelope = await this.documents.envelope(trx, tenantId, documentId);
    if (envelope === null) throw ApiException.notFound();
    const version = await this.documents.schemaVersion(trx, tenantId, documentId);
    if (version === null) throw new Error(`Documento generado sin versión de esquema: ${documentId}`);
    return documentSchemaOf(envelope.type, version);
  }

  /**
   * Deja el documento en un estado de fallo con su motivo. Si ya estaba en ese estado, solo añade un evento
   * cuando el motivo es otro: reintentar el mismo fallo no llena el historial.
   */
  private async fail(
    trx: Transaction<DB>,
    tenantId: string,
    documentId: string,
    from: string,
    failure: string,
    reason: string,
  ): Promise<string> {
    const recorded = reason.length <= MAX_REASON_LENGTH ? reason : reason.slice(0, MAX_REASON_LENGTH);
    if (failure !== from) {
      await this.documents.transition(trx, tenantId, documentId, from, failure, recorded);
    } else if (recorded !== (await this.documents.lastReason(trx, tenantId, documentId, failure))) {
      await this.documents.recordStateChange(trx, tenantId, documentId, from, failure, recorded);
    }
    return failure;
  }
}
