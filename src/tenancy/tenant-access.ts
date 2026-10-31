import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApiException } from '../common/api-exception.js';
import { strip } from '../common/java-text.js';

/**
 * Rol de una persona en una empresa. Solo OWNER y ADMIN modifican la configuración tributaria;
 * BILLER además factura; AUDITOR solo lee.
 */
export type Role = 'OWNER' | 'ADMIN' | 'BILLER' | 'AUDITOR';
export const ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'BILLER', 'AUDITOR'];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function canWrite(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Quién registra clientes y emite comprobantes. */
export function canBill(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'BILLER';
}

/** Rol con el que actúa una API key: factura y consulta, pero no toca la configuración. */
export const API_KEY_ROLE: Role = 'BILLER';

export const TENANT_HEADER = 'X-Tenant-Id';

const roleForbidden = () =>
  new ApiException(403, 'ROLE_FORBIDDEN', 'El rol no permite esta operación');

/**
 * Empresa activa de la petición, ya verificada contra las membresías de la persona (o contra la
 * API key). Es la única fuente de `tenantId` para servicios y consultas: nunca el cuerpo, la ruta
 * ni un mensaje.
 *
 * `userId` es la persona que responde por la petición; con una API key, quien la creó.
 * `apiKeyId` es la key con la que llegó la petición, o null si la hizo una persona.
 */
export class TenantAccess {
  constructor(
    readonly userId: string,
    readonly tenantId: string,
    readonly role: Role,
    readonly apiKeyId: string | null = null,
  ) {}

  get viaApiKey(): boolean {
    return this.apiKeyId !== null;
  }

  requireWrite(): void {
    if (!canWrite(this.role)) throw roleForbidden();
  }

  /** Decisiones que comprometen a la empresa ante el SRI: solo su propietario. */
  requireOwner(): void {
    if (this.role !== 'OWNER') throw roleForbidden();
  }

  /**
   * Alta de productos: OWNER y ADMIN, y también una API key. Una tienda en línea o un ERP factura
   * artículos nuevos y cada línea necesita un productId que ya exista, así que la key tiene que
   * poder crearlo. Una persona con rol BILLER no crea productos desde la web.
   */
  requireProductCreation(): void {
    if (this.viaApiKey) this.requireBilling();
    else this.requireWrite();
  }

  requireBilling(): void {
    if (!canBill(this.role)) throw roleForbidden();
  }
}

// 8-4-4-4-12 en hexadecimal, sin llaves ni guiones omitidos. UUID.fromString de Java admite más
// formas; aquí se exige la canónica.
const UUID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El UUID de la cabecera X-Tenant-Id, en minúsculas; 400 si no tiene la forma canónica. */
export function parseTenantHeader(header: string): string {
  const value = strip(header);
  if (!UUID_FORM.test(value)) {
    throw new ApiException(
      400,
      'TENANT_HEADER_INVALID',
      `La cabecera ${TENANT_HEADER} debe ser un UUID`,
    );
  }
  return value.toLowerCase();
}

const ACCESS = Symbol('einvoice.tenantAccess');
type Carrier = Request & { [ACCESS]?: TenantAccess };

export function setTenantAccess(req: Request, access: TenantAccess): void {
  (req as Carrier)[ACCESS] = access;
}

/**
 * La empresa activa que dejó TenantAccessGuard. Si el guard no corrió es un error de programación
 * y falla cerrado: ningún camino devuelve un `tenantId` sin verificar.
 */
export function tenantAccessOf(req: Request): TenantAccess {
  const access = (req as Carrier)[ACCESS];
  if (access === undefined) {
    throw new Error('Falta @UseGuards(TenantAccessGuard) en la ruta que usa @Tenant()');
  }
  return access;
}

/** La empresa activa; la ruta debe llevar `@UseGuards(TenantAccessGuard)`. */
export const Tenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantAccess =>
    tenantAccessOf(context.switchToHttp().getRequest<Request>()),
);
