import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { UuidPipe } from '../common/uuid.pipe.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { CreateTaxpayerDto, UpdateTaxpayerDto } from './taxpayer.dto.js';
import { TaxpayerService, type TaxpayerView } from './taxpayer.service.js';

/** Emisores de la empresa activa. Los métodos van en el orden del controlador de Java. */
@Controller('taxpayers')
@UseGuards(TenantAccessGuard)
export class TaxpayerController {
  constructor(private readonly service: TaxpayerService) {}

  @Post()
  @HttpCode(201)
  create(@Tenant() access: TenantAccess, @Body() request: CreateTaxpayerDto): Promise<TaxpayerView> {
    return this.service.create(access, {
      ruc: request.ruc,
      legalName: request.legalName,
      tradeName: request.tradeName ?? null,
      headOfficeAddress: request.headOfficeAddress,
      phone: request.phone ?? null,
      defaultEnvironment: request.defaultEnvironment,
      accountingRequired: request.accountingRequired === true,
      specialTaxpayerCode: request.specialTaxpayerCode ?? null,
      withholdingAgentCode: request.withholdingAgentCode ?? null,
      rimpeRegime: request.rimpeRegime ?? 'NONE',
    });
  }

  @Patch(':id')
  update(
    @Tenant() access: TenantAccess,
    @Param('id', UuidPipe) id: string,
    @Body() request: UpdateTaxpayerDto,
  ): Promise<TaxpayerView> {
    return this.service.changePhone(access, id, request.phone);
  }

  @Get()
  list(@Tenant() access: TenantAccess): Promise<TaxpayerView[]> {
    return this.service.list(access);
  }

  @Get(':id')
  get(@Tenant() access: TenantAccess, @Param('id', UuidPipe) id: string): Promise<TaxpayerView> {
    return this.service.get(access, id);
  }
}
