import { JsonString, NoControlChars, NotBlank } from '../common/bean-validation.js';

/** El largo (1 a 80 tras recortar) lo comprueba el servicio, que recorta también espacios Unicode. */
export class CreateApiKeyDto {
  @JsonString()
  @NotBlank()
  @NoControlChars()
  name!: string;
}
