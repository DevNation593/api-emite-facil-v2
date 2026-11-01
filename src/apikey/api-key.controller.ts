import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { UuidPipe } from '../common/uuid.pipe.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { CreateApiKeyDto } from './api-key.dto.js';
import { ApiKeyService, type ApiKeyView, type CreatedApiKey } from './api-key.service.js';

/** API keys de la empresa activa: solo OWNER y ADMIN (lo comprueba el servicio). */
@Controller('api-keys')
@UseGuards(TenantAccessGuard)
export class ApiKeyController {
  constructor(private readonly keys: ApiKeyService) {}

  @Post()
  @HttpCode(201)
  create(@Tenant() access: TenantAccess, @Body() request: CreateApiKeyDto): Promise<CreatedApiKey> {
    return this.keys.create(access, request.name);
  }

  @Get()
  list(@Tenant() access: TenantAccess): Promise<ApiKeyView[]> {
    return this.keys.list(access);
  }

  @Delete(':id')
  @HttpCode(204)
  revoke(@Tenant() access: TenantAccess, @Param('id', UuidPipe) id: string): Promise<void> {
    return this.keys.revoke(access, id);
  }
}
