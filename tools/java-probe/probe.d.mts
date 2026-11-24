export interface ProbeRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[]>;
  body?: string;
}

export interface ProbeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type Send = (request: ProbeRequest) => Promise<ProbeResponse>;
export function sendRaw(base: string, request: ProbeRequest): Promise<ProbeResponse>;

export interface Scenario {
  headers: Record<string, string>;
  values: Record<
    'email' | 'tenantId' | 'taxpayerId' | 'establishmentId' | 'emissionPointId' | 'customerId' | 'productId',
    string
  > &
    Record<string, string>;
  /** Cabeceras de los otros usuarios del escenario de E4: `auditor`, `biller` y `stranger`. */
  actors?: Record<string, Record<string, string>>;
  /** El día fiscal (YYYY-MM-DD, America/Guayaquil) fijado al crear el escenario. */
  today: string;
}

export interface ProbeCase {
  name: string;
  method: string;
  path: string;
  query?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string | string[]>;
  /** Guarda el `id` de la respuesta 2xx como `scenario.values[capture]`, usable luego como `{capture}`. */
  capture?: string;
  /** Cabeceras de la respuesta (en minúsculas) que el resultado guarda además de las de siempre. */
  checkHeaders?: string[];
  /** `owner`, `none` o un usuario de `scenario.actors` (`auditor`, `biller`, `stranger`). */
  auth: string;
}

export interface ProbeResult {
  name: string;
  request: Omit<ProbeCase, 'name' | 'capture' | 'checkHeaders'>;
  status: number;
  contentType: string | string[] | null;
  allow: string | string[] | null;
  body: unknown;
  /** Solo si el caso tiene `checkHeaders`. */
  headers?: Record<string, string | string[] | null>;
}

export const SCENARIO_RUC: string;
export interface SeededAttempt {
  operation: 'RECEPTION' | 'AUTHORIZATION';
  environment: string;
  /** El instante tal como la API lo devuelve; también es lo que se inserta (con microsegundos). */
  startedAt: string;
  completedAt: string | null;
  outcome: string | null;
  sriStatus: string | null;
  httpStatus: number | null;
  errorDetail: string | null;
  /** Respuesta cruda del SRI (texto UTF-8 que se guarda como bytea) o null. */
  response: string | null;
  messages: { identifier: string; message: string; additionalInfo: string; type: string }[];
}
/** Los intentos que `seedAttempts` inserta, del más antiguo al más reciente. */
export const SEEDED_ATTEMPTS: SeededAttempt[];
export interface SeededArtifact {
  kind: 'XML_UNSIGNED' | 'XML_SIGNED' | 'SRI_AUTHORIZATION' | 'XML_AUTHORIZED' | 'RIDE_PDF';
  content: string;
}
export const SEEDED_ARTIFACTS: SeededArtifact[];
export interface SeededDelivery {
  recipient: string;
  status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  /** `owner`: quien creó el comprobante. Nulo: la entrega automática. */
  requestedBy: 'owner' | null;
}
export const SEEDED_DELIVERIES: SeededDelivery[];
export const LIMIT_DELIVERIES: SeededDelivery[];
export interface ScenarioHooks {
  authorize(documentId: string): Promise<void>;
  /** E4: inserta `SEEDED_ATTEMPTS` (y sus mensajes) en el comprobante. */
  seedAttempts?(documentId: string): Promise<void>;
  /** E4: pone el comprobante en el estado dado (`RETURNED`, `NOT_AUTHORIZED`). */
  setState?(documentId: string, state: string): Promise<void>;
  /** E4: crea la membresía activa de la persona con ese correo en la empresa. */
  addMember?(tenantId: string, email: string, role: 'AUDITOR' | 'BILLER'): Promise<void>;
  /** E5: guarda `SEEDED_ARTIFACTS` en el comprobante. */
  seedArtifacts?(documentId: string): Promise<void>;
  /** E5: inserta esas entregas en el comprobante. */
  seedDeliveries?(documentId: string, deliveries: SeededDelivery[]): Promise<void>;
}
export function runScenario(send: Send, hooks?: ScenarioHooks): Promise<Scenario>;
export function caseRequest(probe: ProbeCase, scenario: Scenario): ProbeRequest;
export function normalize(value: unknown, scenario: Scenario): unknown;
export function runProbes(send: Send, cases: ProbeCase[], scenario: Scenario): Promise<ProbeResult[]>;
