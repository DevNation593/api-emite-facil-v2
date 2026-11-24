import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { SriConfig } from './sri-config.js';
import type { SriEnvironment } from './sri-environment.js';
import { parseAuthorization, parseReception } from './sri-response-parser.js';
import {
  failedAuthorization,
  failedReception,
  type AuthorizationResult,
  type ReceptionResult,
} from './sri-results.js';
import { authorizationRequest, InvalidAccessKeyError, receptionRequest } from './sri-soap-requests.js';

/*
 * Cliente SOAP de los servicios del SRI, como sri/HttpSriGateway.java. No sigue redirecciones, no reintenta
 * por su cuenta y acota tanto el tiempo total de cada llamada como el tamaño de la respuesta. Ninguna
 * operación lanza por fallos de red o respuestas ilegibles: devuelven FAILED, que quien llama trata como
 * "no se sabe".
 */

export const SRI_GATEWAY = Symbol('SRI_GATEWAY');

export interface SriGateway {
  /** validarComprobante: envía el XML firmado. */
  receive(environment: SriEnvironment, signedXml: Buffer): Promise<ReceptionResult>;
  /** autorizacionComprobante: consulta el estado por clave de acceso. */
  authorize(environment: SriEnvironment, accessKey: string): Promise<AuthorizationResult>;
}

/** Tamaño máximo de respuesta que se lee. Una autorización lleva dentro el comprobante (320 KB como mucho). */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Parte de una respuesta de error que se conserva como evidencia. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Resultado del intercambio HTTP: con error si no hubo una respuesta 200 completa. */
interface Exchange {
  status: number | null;
  body: Buffer | null;
  error: string | null;
}

/**
 * Nombre del fallo como el de la excepción de Java: solo el tipo, nunca el mensaje, que puede llevar la
 * dirección.
 */
type FailureKind =
  | 'ConnectException'
  | 'HttpConnectTimeoutException'
  | 'HttpTimeoutException'
  | 'IOException';

class TransportFailure extends Error {
  constructor(readonly kind: FailureKind | 'tooLarge' | 'deadline') {
    super(kind);
  }
}

function failureOf(error: NodeJS.ErrnoException): FailureKind {
  switch (error.code) {
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'ConnectException';
    default:
      return 'IOException';
  }
}

export class HttpSriGateway implements SriGateway {
  constructor(private readonly config: SriConfig) {}

  async receive(environment: SriEnvironment, signedXml: Buffer): Promise<ReceptionResult> {
    const exchange = await this.post(this.config.endpoints[environment].reception, receptionRequest(signedXml));
    if (exchange.error !== null) return failedReception(exchange.status, exchange.error, exchange.body);
    return { ...parseReception(exchange.body!), httpStatus: exchange.status, rawResponse: exchange.body };
  }

  async authorize(environment: SriEnvironment, accessKey: string): Promise<AuthorizationResult> {
    let soap: Buffer;
    try {
      soap = authorizationRequest(accessKey);
    } catch (error) {
      if (error instanceof InvalidAccessKeyError) return failedAuthorization(null, error.message, null);
      throw error;
    }
    const exchange = await this.post(this.config.endpoints[environment].authorization, soap);
    if (exchange.error !== null) return failedAuthorization(exchange.status, exchange.error, exchange.body);
    return { ...parseAuthorization(exchange.body!), httpStatus: exchange.status, rawResponse: exchange.body };
  }

  private async post(endpoint: URL, soap: Buffer): Promise<Exchange> {
    let response: { status: number; body: Buffer };
    try {
      response = await this.send(endpoint, soap);
    } catch (error) {
      const kind = error instanceof TransportFailure ? error.kind : 'IOException';
      if (kind === 'tooLarge') return { status: null, body: null, error: 'La respuesta del SRI es demasiado grande' };
      if (kind === 'deadline') {
        return { status: null, body: null, error: 'Sin respuesta del SRI: tiempo de espera agotado' };
      }
      return { status: null, body: null, error: `Sin respuesta del SRI: ${kind}` };
    }
    if (response.status !== 200) {
      return {
        status: response.status,
        body: response.body.length <= MAX_ERROR_BODY_BYTES ? response.body : response.body.subarray(0, MAX_ERROR_BODY_BYTES),
        error: `El SRI respondió HTTP ${response.status}`,
      };
    }
    return { status: 200, body: response.body, error: null };
  }

  /**
   * Un POST HTTP/1.1 sin redirecciones ni conexiones reutilizadas. Plazos como el cliente del JDK: conexión
   * (`connectTimeoutMs`), cabeceras de respuesta (`readTimeoutMs` desde que sale la petición) y un plazo total
   * de conexión + lectura que cubre también la lectura del cuerpo.
   */
  private send(endpoint: URL, soap: Buffer): Promise<{ status: number; body: Buffer }> {
    const { connectTimeoutMs, readTimeoutMs } = this.config;
    return new Promise((resolve, reject) => {
      const timers: NodeJS.Timeout[] = [];
      let request: ClientRequest | undefined;
      let settled = false;
      const finish = (error: TransportFailure | null, value?: { status: number; body: Buffer }) => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        if (error !== null) {
          request?.destroy();
          reject(error);
        } else {
          resolve(value!);
        }
      };
      timers.push(setTimeout(() => finish(new TransportFailure('deadline')), connectTimeoutMs + readTimeoutMs));

      const options = {
        method: 'POST',
        agent: false as const,
        headers: {
          'Content-Type': 'text/xml; charset=UTF-8',
          SOAPAction: '""',
          'Content-Length': String(soap.length),
        },
      };
      const onResponse = (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(new TransportFailure('tooLarge'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => finish(null, { status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
        response.on('close', () => {
          if (!response.complete) finish(new TransportFailure('IOException'));
        });
        response.on('error', (error) => finish(new TransportFailure(failureOf(error))));
      };
      request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(endpoint, options, (response) => {
        onResponse(response);
      });
      request.on('error', (error: NodeJS.ErrnoException) => finish(new TransportFailure(failureOf(error))));
      request.on('socket', (socket) => {
        const connect = setTimeout(() => finish(new TransportFailure('HttpConnectTimeoutException')), connectTimeoutMs);
        timers.push(connect);
        socket.once(endpoint.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
          clearTimeout(connect);
        });
      });
      request.on('response', () => {
        // Las cabeceras llegaron: el plazo de lectura de la petición ya no aplica.
        clearTimeout(headers);
      });
      const headers = setTimeout(() => finish(new TransportFailure('HttpTimeoutException')), readTimeoutMs);
      timers.push(headers);
      request.end(soap);
    });
  }
}
