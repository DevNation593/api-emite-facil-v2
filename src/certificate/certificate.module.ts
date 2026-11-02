import { Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { AuditLog } from '../compliance/audit-log.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DATABASE } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { TaxpayerModule } from '../taxpayer/taxpayer.module.js';
import { TaxpayerService } from '../taxpayer/taxpayer.service.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { CertificateController } from './certificate.controller.js';
import { CertificateService } from './certificate.service.js';
import { AesGcmSecretCipher, SECRET_CIPHER } from './secret-cipher.js';

/** Certificados de firma y el cifrado de secretos en reposo (que E6 usa también para los webhooks). */
@Module({
  imports: [TenancyModule, ComplianceModule, TaxpayerModule],
  controllers: [CertificateController],
  providers: [
    {
      provide: SECRET_CIPHER,
      useFactory: (config: AppConfig) => new AesGcmSecretCipher(config.masterKey),
      inject: [APP_CONFIG],
    },
    {
      provide: CertificateService,
      useFactory: (db: Kysely<DB>, cipher: AesGcmSecretCipher, audit: AuditLog, taxpayers: TaxpayerService) =>
        new CertificateService(db, cipher, audit, taxpayers),
      inject: [DATABASE, SECRET_CIPHER, AuditLog, TaxpayerService],
    },
  ],
  exports: [SECRET_CIPHER, CertificateService],
})
export class CertificateModule {}
