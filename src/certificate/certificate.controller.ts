import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { JsonString, JsonUuid, NotBlank, NotNull, Size } from '../common/bean-validation.js';
import { decodeJavaBase64 } from '../common/java-base64.js';
import { RequiredUuidQueryPipe } from '../common/query-params.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { CertificateService, type CertificateView } from './certificate.service.js';

/** 64 KB de archivo son unos 87 400 caracteres en Base64. */
const MAX_BASE64_LENGTH = 90_000;

export class UploadCertificateDto {
  @JsonUuid()
  @NotNull()
  taxpayerId!: string;

  @JsonString()
  @NotBlank()
  @Size({ max: MAX_BASE64_LENGTH })
  p12!: string;

  @JsonString()
  @NotBlank()
  @Size({ max: 200 })
  password!: string;

  /** El contenido nunca debe acabar en un log por un volcado accidental de la petición. */
  toString(): string {
    return `UploadCertificateRequest[taxpayerId=${this.taxpayerId}]`;
  }

  toJSON(): { taxpayerId: string } {
    return { taxpayerId: this.taxpayerId };
  }
}

@Controller('certificates')
@UseGuards(TenantAccessGuard)
export class CertificateController {
  constructor(private readonly service: CertificateService) {}

  @Post()
  @HttpCode(201)
  async upload(@Tenant() access: TenantAccess, @Body() request: UploadCertificateDto): Promise<CertificateView> {
    const p12 = decodeJavaBase64(request.p12);
    if (p12 === null) {
      throw new ApiException(400, 'MALFORMED_REQUEST', 'El campo p12 debe venir en Base64');
    }
    try {
      return await this.service.upload(access, request.taxpayerId, p12, request.password);
    } finally {
      p12.fill(0);
    }
  }

  @Get()
  list(
    @Tenant() access: TenantAccess,
    @Query('taxpayerId', RequiredUuidQueryPipe) taxpayerId: string,
  ): Promise<CertificateView[]> {
    return this.service.list(access, taxpayerId);
  }
}
