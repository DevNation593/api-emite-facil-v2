import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { RequiredUuidQueryPipe } from '../common/query-params.js';
import { UuidPipe } from '../common/uuid.pipe.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { CreateEmissionPointDto, CreateEstablishmentDto } from './taxpayer.dto.js';
import {
  type EmissionPointView,
  EstablishmentService,
  type EstablishmentView,
} from './establishment.service.js';

@Controller('taxpayers/:taxpayerId/establishments')
@UseGuards(TenantAccessGuard)
export class EstablishmentController {
  constructor(private readonly service: EstablishmentService) {}

  @Post()
  @HttpCode(201)
  create(
    @Tenant() access: TenantAccess,
    @Param('taxpayerId', UuidPipe) taxpayerId: string,
    @Body() request: CreateEstablishmentDto,
  ): Promise<EstablishmentView> {
    return this.service.createEstablishment(access, taxpayerId, request.code, request.address);
  }

  @Get()
  list(
    @Tenant() access: TenantAccess,
    @Param('taxpayerId', UuidPipe) taxpayerId: string,
  ): Promise<EstablishmentView[]> {
    return this.service.listEstablishments(access, taxpayerId);
  }
}

@Controller('emission-points')
@UseGuards(TenantAccessGuard)
export class EmissionPointController {
  constructor(private readonly service: EstablishmentService) {}

  @Post()
  @HttpCode(201)
  create(@Tenant() access: TenantAccess, @Body() request: CreateEmissionPointDto): Promise<EmissionPointView> {
    return this.service.createEmissionPoint(access, request.establishmentId, request.code);
  }

  @Get()
  list(
    @Tenant() access: TenantAccess,
    @Query('establishmentId', RequiredUuidQueryPipe) establishmentId: string,
  ): Promise<EmissionPointView[]> {
    return this.service.listEmissionPoints(access, establishmentId);
  }
}
