import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { ApiException } from '../common/api-exception.js';
import type { ErrorCode } from '../common/error-codes.js';
import { offsetDateTimeJson, offsetDateTimeToString } from '../common/java-time.js';
import type { AuditLog } from '../compliance/audit-log.js';
import type { DB } from '../database/schema.js';
import type { TaxpayerService } from '../taxpayer/taxpayer.service.js';
import type { TenantAccess } from '../tenancy/tenant-access.js';
import { CertificateRejectedException, inspectPkcs12, type SigningMaterial } from './pkcs12-inspector.js';
import type { AesGcmSecretCipher } from './secret-cipher.js';

/** Metadatos de un certificado; nunca su contenido. Las propiedades de CertificateView de Java, en su orden. */
export interface CertificateView {
  id: string;
  taxpayerId: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  fingerprintSha256: string;
  validFrom: string;
  validTo: string;
  status: string;
}

const VIEW_COLUMNS = [
  'id',
  'taxpayer_id',
  'subject',
  'issuer',
  'serial_number',
  'fingerprint_sha256',
  'valid_from',
  'valid_to',
  'status',
] as const;

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function view(row: {
  id: string;
  taxpayer_id: string;
  subject: string;
  issuer: string;
  serial_number: string;
  fingerprint_sha256: string;
  valid_from: Date | string;
  valid_to: Date | string;
  status: string;
}): CertificateView {
  return {
    id: row.id,
    taxpayerId: row.taxpayer_id,
    subject: row.subject,
    issuer: row.issuer,
    serialNumber: row.serial_number,
    fingerprintSha256: row.fingerprint_sha256,
    validFrom: offsetDateTimeJson(date(row.valid_from)),
    validTo: offsetDateTimeJson(date(row.valid_to)),
    status: row.status,
  };
}

/**
 * Datos autenticados junto con cada secreto. Lo ligan a su empresa, su emisor, su certificado y su
 * campo: quien pueda escribir en la base no puede hacer que el certificado de un emisor firme por
 * otro, ni intercambiar el archivo con la contraseña.
 */
export function secretContext(
  tenantId: string,
  taxpayerId: string,
  certificateId: string,
  field: 'p12' | 'password',
): Buffer {
  return Buffer.from(`certificate|${tenantId}|${taxpayerId}|${certificateId}|${field}`, 'utf8');
}

/**
 * Certificados de firma de los emisores. El PKCS#12 y su contraseña se guardan cifrados y solo se
 * descifran en memoria al firmar; nunca salen por la API, ni van a la bitácora, ni a los logs.
 */
export class CertificateService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly cipher: AesGcmSecretCipher,
    private readonly audit: AuditLog,
    private readonly taxpayers: TaxpayerService,
  ) {}

  /** Valida el certificado, lo guarda cifrado y lo deja como el activo del emisor. */
  upload(access: TenantAccess, taxpayerId: string, p12: Buffer, password: string): Promise<CertificateView> {
    access.requireWrite();
    return this.db.transaction().execute(async (trx) => {
      // El bloqueo del emisor ordena dos cargas simultáneas: solo puede quedar un certificado activo.
      const taxpayer = await trx
        .selectFrom('taxpayers')
        .select('id')
        .where('id', '=', taxpayerId)
        .where('tenant_id', '=', access.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (taxpayer === undefined) throw ApiException.notFound();
      let material: SigningMaterial;
      try {
        material = await inspectPkcs12(p12, password, new Date());
      } catch (error) {
        if (error instanceof CertificateRejectedException) {
          throw new ApiException(422, error.errorCode as ErrorCode, error.message);
        }
        throw error;
      }
      const id = randomUUID();
      const passwordBytes = Buffer.from(password, 'utf8');
      const encryptedP12 = this.cipher.encrypt(p12, secretContext(access.tenantId, taxpayerId, id, 'p12'));
      const encryptedPassword = this.cipher.encrypt(
        passwordBytes,
        secretContext(access.tenantId, taxpayerId, id, 'password'),
      );
      passwordBytes.fill(0);
      const fingerprint = createHash('sha256').update(material.certificateDer).digest('hex');
      const { certificate } = material;
      await trx
        .updateTable('certificates')
        .set({ status: 'REPLACED' })
        .where('taxpayer_id', '=', taxpayerId)
        .where('status', '=', 'ACTIVE')
        .execute();
      const row = await trx
        .insertInto('certificates')
        .values({
          id,
          tenant_id: access.tenantId,
          taxpayer_id: taxpayerId,
          subject: certificate.subject,
          issuer: certificate.issuer,
          serial_number: certificate.serialNumber,
          fingerprint_sha256: fingerprint,
          valid_from: certificate.notBefore,
          valid_to: certificate.notAfter,
          status: 'ACTIVE',
          encrypted_p12: encryptedP12,
          encrypted_password: encryptedPassword,
          created_by: access.userId,
        })
        .returning(VIEW_COLUMNS)
        .executeTakeFirstOrThrow();
      await this.audit.recordFor(trx, access, 'CERTIFICATE_UPLOADED', 'CERTIFICATE', id, {
        taxpayerId,
        fingerprintSha256: fingerprint,
        // OffsetDateTime.toString() de Java: sin segundos si son cero.
        validTo: offsetDateTimeToString(certificate.notAfter),
      });
      return view(row);
    });
  }

  /** Metadatos de los certificados del emisor, el más reciente primero. Nunca el contenido. */
  async list(access: TenantAccess, taxpayerId: string): Promise<CertificateView[]> {
    if ((await this.taxpayers.findForTenant(this.db, access.tenantId, taxpayerId)) === null) {
      throw ApiException.notFound();
    }
    const rows = await this.db
      .selectFrom('certificates')
      .select(VIEW_COLUMNS)
      .where('tenant_id', '=', access.tenantId)
      .where('taxpayer_id', '=', taxpayerId)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .execute();
    return rows.map(view);
  }

  /**
   * Clave y certificado activos del emisor, listos para firmar. La vigencia se vuelve a comprobar
   * contra `now`: un certificado pudo caducar después de cargarse. No abre transacción: el rechazo
   * es un resultado que quien llama registra.
   */
  async signingMaterial(tenantId: string, taxpayerId: string, now: Date): Promise<SigningMaterial> {
    const active = await this.db
      .selectFrom('certificates')
      .select(['id', 'encrypted_p12', 'encrypted_password'])
      .where('tenant_id', '=', tenantId)
      .where('taxpayer_id', '=', taxpayerId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (active === undefined) {
      throw new CertificateRejectedException('CERTIFICATE_MISSING', 'El emisor no tiene un certificado de firma activo');
    }
    const p12 = this.cipher.decrypt(active.encrypted_p12, secretContext(tenantId, taxpayerId, active.id, 'p12'));
    const passwordBytes = this.cipher.decrypt(
      active.encrypted_password,
      secretContext(tenantId, taxpayerId, active.id, 'password'),
    );
    try {
      return await inspectPkcs12(p12, passwordBytes.toString('utf8'), now);
    } finally {
      p12.fill(0);
      passwordBytes.fill(0);
    }
  }
}
