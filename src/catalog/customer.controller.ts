import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { PageResponse } from '../common/pagination.js';
import { IntQueryPipe, StringQueryPipe } from '../common/query-params.js';
import { UuidPipe } from '../common/uuid.pipe.js';
import { Tenant, type TenantAccess } from '../tenancy/tenant-access.js';
import { TenantAccessGuard } from '../tenancy/tenant-access.guard.js';
import { CustomerDto, ProductDto } from './catalog.dto.js';
import { CustomerService, type CustomerView } from './customer.service.js';
import { ProductService, type ProductView } from './product.service.js';

/** Los métodos van en el orden del controlador de Java. */
@Controller('customers')
@UseGuards(TenantAccessGuard)
export class CustomerController {
  constructor(private readonly service: CustomerService) {}

  @Post()
  @HttpCode(201)
  create(@Tenant() access: TenantAccess, @Body() request: CustomerDto): Promise<CustomerView> {
    return this.service.create(access, request);
  }

  @Get()
  list(
    @Tenant() access: TenantAccess,
    @Query('page', new IntQueryPipe(0)) page: number,
    @Query('size', new IntQueryPipe(20)) size: number,
    @Query('q', new StringQueryPipe('')) q: string,
  ): Promise<PageResponse<CustomerView>> {
    return this.service.search(access, q, page, size);
  }

  @Get(':id')
  async get(@Tenant() access: TenantAccess, @Param('id', UuidPipe) id: string): Promise<CustomerView> {
    const { version: _version, ...customer } = await this.service.get(access, id);
    return customer;
  }

  @Put(':id')
  update(
    @Tenant() access: TenantAccess,
    @Param('id', UuidPipe) id: string,
    @Body() request: CustomerDto,
  ): Promise<CustomerView> {
    return this.service.update(access, id, request);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Tenant() access: TenantAccess, @Param('id', UuidPipe) id: string): Promise<void> {
    return this.service.delete(access, id);
  }
}

@Controller('products')
@UseGuards(TenantAccessGuard)
export class ProductController {
  constructor(private readonly service: ProductService) {}

  @Post()
  @HttpCode(201)
  create(@Tenant() access: TenantAccess, @Body() request: ProductDto): Promise<ProductView> {
    return this.service.create(access, request);
  }

  @Get()
  list(
    @Tenant() access: TenantAccess,
    @Query('page', new IntQueryPipe(0)) page: number,
    @Query('size', new IntQueryPipe(20)) size: number,
    @Query('q', new StringQueryPipe('')) q: string,
  ): Promise<PageResponse<ProductView>> {
    return this.service.search(access, q, page, size);
  }

  @Get(':id')
  async get(@Tenant() access: TenantAccess, @Param('id', UuidPipe) id: string): Promise<ProductView> {
    const { version: _version, ...product } = await this.service.get(access, id);
    return product;
  }

  @Put(':id')
  update(
    @Tenant() access: TenantAccess,
    @Param('id', UuidPipe) id: string,
    @Body() request: ProductDto,
  ): Promise<ProductView> {
    return this.service.update(access, id, request);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Tenant() access: TenantAccess, @Param('id', UuidPipe) id: string): Promise<void> {
    return this.service.delete(access, id);
  }
}
