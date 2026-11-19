import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authorized, received } from './sri-soap-samples.js';

/*
 * SRI simulado: un servidor HTTP local (127.0.0.1, puerto libre) que responde a la recepción y a la
 * autorización según un guion por clave de acceso. Sin guion, recibe y autoriza todo. Port de
 * support/SriStub.java.
 */

const ACCESS_KEY_IN_INVOICE = /<claveAcceso>([0-9]{49})<\/claveAcceso>/;
const BASE64_XML = /<xml>([^<]*)<\/xml>/;
const CONSULTED_KEY = /<claveAccesoComprobante>\s*([^<\s]*)\s*<\/claveAccesoComprobante>/;

/** Una respuesta del guion. */
export interface Reply {
  status: number;
  body: Buffer;
  delayMs: number;
  drop: boolean;
}

export const Reply = {
  xml: (body: string): Reply => ({ status: 200, body: Buffer.from(body, 'utf8'), delayMs: 0, drop: false }),
  status: (status: number, body: string): Reply => ({ status, body: Buffer.from(body, 'utf8'), delayMs: 0, drop: false }),
  bytes: (size: number): Reply => ({ status: 200, body: Buffer.alloc(size, 'x'), delayMs: 0, drop: false }),
  delayed: (delayMs: number, reply: Reply): Reply => ({ ...reply, delayMs }),
  /** Una respuesta cualquiera con cabeceras propias (por ejemplo, una redirección). */
  withHeaders: (reply: Reply, headers: Record<string, string>): Reply & { headers: Record<string, string> } => ({
    ...reply,
    headers,
  }),
  /** Corta la conexión sin responder. */
  dropConnection: (): Reply => ({ status: 0, body: Buffer.alloc(0), delayMs: 0, drop: true }),
};

/** Lo que llegó en una petición. */
export interface Captured {
  contentType: string | undefined;
  soapAction: string | undefined;
  body: Buffer;
}

class Script {
  private readonly replies: Reply[] = [];
  private readonly requests: Captured[] = [];
  private xml: Buffer | null = null;

  next(request: Captured, xml: Buffer | null): Reply | null {
    this.requests.push(request);
    this.xml = xml;
    if (this.replies.length === 0) return null;
    return this.replies.length > 1 ? this.replies.shift()! : this.replies[0]!;
  }

  set(replies: Reply[]): void {
    this.replies.splice(0, this.replies.length, ...replies);
  }

  calls(): number {
    return this.requests.length;
  }

  last(): Captured | null {
    return this.requests.at(-1) ?? null;
  }

  lastXml(): Buffer | null {
    return this.xml;
  }
}

export class SriStub {
  private readonly reception = new Map<string, Script>();
  private readonly authorization = new Map<string, Script>();

  private constructor(private readonly server: Server) {}

  static async start(): Promise<SriStub> {
    const server = createServer();
    const stub = new SriStub(server);
    server.on('request', (request, response) => void stub.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return stub;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get receptionUrl(): string {
    return `http://127.0.0.1:${this.port}/recepcion`;
  }

  get authorizationUrl(): string {
    return `http://127.0.0.1:${this.port}/autorizacion`;
  }

  /** Cada petición consume la siguiente respuesta; la última se repite. */
  onReception(accessKey: string, ...replies: Reply[]): void {
    this.script(this.reception, accessKey).set(replies);
  }

  onAuthorization(accessKey: string, ...replies: Reply[]): void {
    this.script(this.authorization, accessKey).set(replies);
  }

  receptionCalls(accessKey: string): number {
    return this.script(this.reception, accessKey).calls();
  }

  authorizationCalls(accessKey: string): number {
    return this.script(this.authorization, accessKey).calls();
  }

  /** XML del comprobante que llegó en la última recepción de esa clave, ya decodificado. */
  lastReceptionXml(accessKey: string): Buffer | null {
    return this.script(this.reception, accessKey).lastXml();
  }

  lastReception(accessKey: string): Captured | null {
    return this.script(this.reception, accessKey).last();
  }

  lastAuthorization(accessKey: string): Captured | null {
    return this.script(this.authorization, accessKey).last();
  }

  private script(scripts: Map<string, Script>, accessKey: string): Script {
    let script = scripts.get(accessKey);
    if (!script) {
      script = new Script();
      scripts.set(accessKey, script);
    }
    return script;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const captured: Captured = {
      contentType: request.headers['content-type'],
      soapAction: request.headers.soapaction as string | undefined,
      body: Buffer.concat(chunks),
    };
    const soap = captured.body.toString('utf8');
    let reply: Reply | null;
    if (request.url?.startsWith('/recepcion')) {
      const encoded = BASE64_XML.exec(soap);
      const xml = encoded ? Buffer.from(encoded[1]!, 'base64') : Buffer.alloc(0);
      const accessKey = ACCESS_KEY_IN_INVOICE.exec(xml.toString('utf8'))?.[1] ?? 'sin-clave';
      reply = this.script(this.reception, accessKey).next(captured, xml) ?? Reply.xml(received());
    } else if (request.url?.startsWith('/autorizacion')) {
      const accessKey = CONSULTED_KEY.exec(soap)?.[1] ?? 'sin-clave';
      reply = this.script(this.authorization, accessKey).next(captured, null) ?? Reply.xml(authorized(accessKey));
    } else {
      reply = Reply.status(404, '');
    }
    await respond(response, reply);
  }
}

async function respond(response: ServerResponse, reply: Reply & { headers?: Record<string, string> }): Promise<void> {
  if (reply.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
  if (response.destroyed) return;
  if (reply.drop) {
    response.socket?.destroy();
    return;
  }
  response.setHeader('Content-Type', 'text/xml; charset=UTF-8');
  for (const [name, value] of Object.entries(reply.headers ?? {})) response.setHeader(name, value);
  response.setHeader('Content-Length', String(reply.body.length));
  response.writeHead(reply.status);
  // El cliente puede irse antes (por ejemplo, por su plazo): no es un fallo del simulador.
  response.on('error', () => undefined);
  response.end(reply.body);
}

/**
 * Variables con las que la aplicación de pruebas habla con el SRI simulado: solo el ambiente 1 habilitado,
 * con esperas mínimas (simulatedSri de AbstractIntegrationTest).
 */
export function sriTestEnv(stub: SriStub): Record<string, string> {
  return {
    SRI_ENABLED_ENVIRONMENTS: '1',
    EINVOICE_SRI_ALLOW_CUSTOM_ENDPOINTS: 'true',
    EINVOICE_SRI_TEST_RECEPTION: stub.receptionUrl,
    EINVOICE_SRI_TEST_AUTHORIZATION: stub.authorizationUrl,
    EINVOICE_SRI_PRODUCTION_RECEPTION: stub.receptionUrl,
    EINVOICE_SRI_PRODUCTION_AUTHORIZATION: stub.authorizationUrl,
    SRI_CONNECT_TIMEOUT: '2s',
    SRI_READ_TIMEOUT: '2s',
    SRI_AUTHORIZATION_DELAY: '0s',
    SRI_RETRY_BACKOFF: '1s',
    SRI_RETRY_MAX: '5',
  };
}
