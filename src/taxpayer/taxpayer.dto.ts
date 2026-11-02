import {
  JsonBoolean,
  JsonEnum,
  JsonString,
  JsonUuid,
  NoControlChars,
  NotBlank,
  NotNull,
  Pattern,
  Size,
} from '../common/bean-validation.js';

/** Régimen RIMPE del emisor; determina la leyenda contribuyenteRimpe del comprobante (ficha, Anexo 22). */
export const RIMPE_REGIMES = ['NONE', 'EMPRENDEDOR', 'NEGOCIO_POPULAR'] as const;
export type RimpeRegime = (typeof RIMPE_REGIMES)[number];

export class CreateTaxpayerDto {
  @JsonString()
  @NotNull()
  @Pattern('[0-9]{10}001')
  ruc!: string;

  @JsonString()
  @NotBlank()
  @Size({ max: 300 })
  @NoControlChars()
  legalName!: string;

  @JsonString()
  @Size({ max: 300 })
  @NoControlChars()
  tradeName?: string | null;

  @JsonString()
  @NotBlank()
  @Size({ max: 300 })
  @NoControlChars()
  headOfficeAddress!: string;

  @JsonString()
  @Size({ max: 30 })
  @NoControlChars()
  phone?: string | null;

  @JsonString()
  @NotNull()
  @Pattern('[12]')
  defaultEnvironment!: string;

  @JsonBoolean()
  accountingRequired?: boolean | null;

  @JsonString()
  @Pattern('[A-Za-z0-9]{3,13}')
  specialTaxpayerCode?: string | null;

  @JsonString()
  @Pattern('[1-9][0-9]{0,7}')
  withholdingAgentCode?: string | null;

  @JsonEnum(RIMPE_REGIMES)
  rimpeRegime?: RimpeRegime | null;
}

/** Lo que se cambia de un emisor ya dado de alta: su teléfono (nulo o en blanco lo quita). */
export class UpdateTaxpayerDto {
  @JsonString()
  @Size({ max: 30 })
  @NoControlChars()
  phone?: string | null;
}

export class CreateEstablishmentDto {
  @JsonString()
  @NotNull()
  @Pattern('[0-9]{3}')
  code!: string;

  @JsonString()
  @NotBlank()
  @Size({ max: 300 })
  @NoControlChars()
  address!: string;
}

export class CreateEmissionPointDto {
  @JsonUuid()
  @NotNull()
  establishmentId!: string;

  @JsonString()
  @NotNull()
  @Pattern('[0-9]{3}')
  code!: string;
}
