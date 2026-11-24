import type { DocumentEnvelope } from './document-envelope.js';

/**
 * El sobre de un comprobante autorizado, con el número y la fecha de autorización que muestra el RIDE
 * (billing/RideEnvelope.java). `authorizedAt` es el instante en UTC con sus microsegundos, sin zona
 * (`YYYY-MM-DDTHH:MM:SS.ffffff`): un `Date` los perdería.
 */
export interface RideEnvelope {
  envelope: DocumentEnvelope;
  authorizationNumber: string | null;
  authorizedAt: string | null;
}
