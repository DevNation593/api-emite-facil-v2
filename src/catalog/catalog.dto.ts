import {
  Email,
  JsonString,
  NoControlChars,
  NotBlank,
  NotNull,
  Pattern,
  Size,
} from '../common/bean-validation.js';
import { QUANTITY_OR_PRICE } from '../common/decimals.js';

/** Alta y edición de un cliente (CreateCustomerRequest de Java). */
export class CustomerDto {
  @JsonString()
  @NotNull()
  @Pattern('[0-9]{2}')
  idType!: string;

  @JsonString()
  @NotBlank()
  @Size({ max: 20 })
  @NoControlChars()
  idNumber!: string;

  @JsonString()
  @NotBlank()
  @Size({ max: 300 })
  @NoControlChars()
  name!: string;

  @JsonString()
  @Email()
  @Size({ max: 254 })
  email?: string | null;

  @JsonString()
  @Size({ max: 300 })
  @NoControlChars()
  address?: string | null;

  @JsonString()
  @Size({ max: 30 })
  @NoControlChars()
  phone?: string | null;
}

/** Alta y edición de un producto (CreateProductRequest de Java). */
export class ProductDto {
  @JsonString()
  @NotNull()
  @Pattern('[A-Za-z0-9._-]{1,25}')
  sku!: string;

  @JsonString()
  @NotBlank()
  @Size({ max: 300 })
  @NoControlChars()
  name!: string;

  @JsonString()
  @NotNull()
  @Pattern(QUANTITY_OR_PRICE)
  unitPrice!: string;

  @JsonString()
  @NotNull()
  @Pattern('[0-9]{1,4}')
  ivaRateCode!: string;
}
