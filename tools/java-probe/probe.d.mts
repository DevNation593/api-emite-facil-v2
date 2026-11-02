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
  auth: 'owner' | 'none';
}

export interface ProbeResult {
  name: string;
  request: Omit<ProbeCase, 'name' | 'capture'>;
  status: number;
  contentType: string | string[] | null;
  allow: string | string[] | null;
  body: unknown;
}

export const SCENARIO_RUC: string;
export interface ScenarioHooks {
  authorize(documentId: string): Promise<void>;
}
export function runScenario(send: Send, hooks?: ScenarioHooks): Promise<Scenario>;
export function caseRequest(probe: ProbeCase, scenario: Scenario): ProbeRequest;
export function normalize(value: unknown, scenario: Scenario): unknown;
export function runProbes(send: Send, cases: ProbeCase[], scenario: Scenario): Promise<ProbeResult[]>;
