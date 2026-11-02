import { Body, Controller, Param, Put, UseGuards } from '@nestjs/common';
import { JsonInteger, JsonString, Max, Min, NotNull, Pattern } from '../common/bean-validation.js';
import { UuidPipe } from '../common/uuid.pipe.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { SequenceService, type SequenceView } from './sequence.service.js';

// Por ahora solo se emiten facturas (01), como en Java.
export class SetSequenceDto {
  @JsonString()
  @NotNull()
  @Pattern('[12]')
  environment!: string;

  @JsonString()
  @NotNull()
  @Pattern('01')
  documentType!: string;

  @JsonInteger()
  @NotNull()
  @Min(1)
  @Max(999_999_999)
  nextValue!: number;
}

/** Permite continuar la numeración de un emisor que ya facturaba con otro sistema. */
@Controller('emission-points/:id/sequence')
@UseGuards(TenantAccessGuard)
export class SequenceController {
  constructor(private readonly service: SequenceService) {}

  @Put()
  set(
    @Tenant() access: TenantAccess,
    @Param('id', UuidPipe) id: string,
    @Body() request: SetSequenceDto,
  ): Promise<SequenceView> {
    return this.service.set(access, id, request.environment, request.documentType, request.nextValue);
  }
}
