import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JsonString, NoControlChars, NotBlank, Size } from '../common/bean-validation.js';
import { CurrentUser, CurrentUserGuard } from '../identity/current-user.guard.js';
import type { UserIdentity } from '../identity/request-identity.js';
import type { TenantView } from './memberships.js';
import { Tenant, type TenantAccess } from './tenant-access.js';
import { TenantAccessGuard } from './tenant-access.guard.js';
import { TenantService } from './tenant.service.js';

export class CreateTenantDto {
  @JsonString()
  @NotBlank()
  @Size({ max: 200 })
  @NoControlChars()
  name!: string;
}

/** Empresas: las de la persona (crear, listar) y la activa de la petición (`/current`). */
@Controller('tenants')
export class TenantController {
  constructor(private readonly service: TenantService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(CurrentUserGuard)
  create(@CurrentUser() user: UserIdentity, @Body() request: CreateTenantDto): Promise<TenantView> {
    return this.service.create(user, request.name);
  }

  @Get()
  @UseGuards(CurrentUserGuard)
  list(@CurrentUser() user: UserIdentity): Promise<TenantView[]> {
    return this.service.listFor(user);
  }

  @Get('current')
  @UseGuards(TenantAccessGuard)
  current(@Tenant() access: TenantAccess): Promise<TenantView> {
    return this.service.current(access);
  }
}
