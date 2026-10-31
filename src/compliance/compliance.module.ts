import { Module } from '@nestjs/common';
import { AuditLog } from './audit-log.js';

@Module({
  providers: [{ provide: AuditLog, useFactory: () => new AuditLog() }],
  exports: [AuditLog],
})
export class ComplianceModule {}
