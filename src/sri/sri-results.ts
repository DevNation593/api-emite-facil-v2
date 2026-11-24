/*
 * Resultados de las llamadas al SRI, como sri/ReceptionResult.java y sri/AuthorizationResult.java.
 * FAILED significa que no se obtuvo una respuesta válida: no dice si el SRI recibió o no el comprobante.
 */

/** Error o advertencia que el SRI devuelve junto a una respuesta, tal como llegó. */
export interface SriMessage {
  identifier: string | null;
  message: string | null;
  additionalInfo: string | null;
  type: string | null;
}

export type ReceptionOutcome = 'RECEIVED' | 'RETURNED' | 'FAILED';

export interface ReceptionResult {
  outcome: ReceptionOutcome;
  sriStatus: string | null;
  messages: SriMessage[];
  httpStatus: number | null;
  errorDetail: string | null;
  rawResponse: Buffer | null;
}

/**
 * NOT_FOUND: el SRI no devolvió ninguna autorización para la clave. PROCESSING: hay una entrada que no es
 * ni autorizada ni rechazada. FAILED: no se obtuvo una respuesta válida.
 */
export type AuthorizationOutcome = 'AUTHORIZED' | 'NOT_AUTHORIZED' | 'PROCESSING' | 'NOT_FOUND' | 'FAILED';

export interface AuthorizationResult {
  outcome: AuthorizationOutcome;
  sriStatus: string | null;
  consultedAccessKey: string | null;
  authorizationNumber: string | null;
  /** `OffsetDateTime.toString()` de Java: instante ISO con el desplazamiento con que llegó. */
  authorizedAt: string | null;
  environmentLabel: string | null;
  messages: SriMessage[];
  httpStatus: number | null;
  errorDetail: string | null;
  rawResponse: Buffer | null;
}

export function failedReception(
  httpStatus: number | null,
  errorDetail: string,
  rawResponse: Buffer | null,
): ReceptionResult {
  return { outcome: 'FAILED', sriStatus: null, messages: [], httpStatus, errorDetail, rawResponse };
}

export function failedAuthorization(
  httpStatus: number | null,
  errorDetail: string,
  rawResponse: Buffer | null,
): AuthorizationResult {
  return {
    outcome: 'FAILED',
    sriStatus: null,
    consultedAccessKey: null,
    authorizationNumber: null,
    authorizedAt: null,
    environmentLabel: null,
    messages: [],
    httpStatus,
    errorDetail,
    rawResponse,
  };
}

export function hasMessage(result: { messages: readonly SriMessage[] }, identifier: string): boolean {
  return result.messages.some((message) => message.identifier === identifier);
}
