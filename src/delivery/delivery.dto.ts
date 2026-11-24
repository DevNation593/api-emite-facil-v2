import { JsonString } from '../common/bean-validation.js';
import { OptionalBody } from '../common/validation.js';

/** Cuerpo, opcional, de POST /documents/{id}/deliveries (DeliveryController.DeliveryRequest de Java). */
@OptionalBody()
export class DeliveryRequestDto {
  @JsonString()
  email?: string | null;
}
