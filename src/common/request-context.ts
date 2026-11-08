import { AsyncLocalStorage } from 'node:async_hooks';

/** `documentId` es el comprobante que emitió la petición, cuando ya lo hay. */
export interface RequestContext {
  correlationId: string;
  documentId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function currentDocumentId(): string | undefined {
  return storage.getStore()?.documentId;
}

/** Anota en la petición en curso el comprobante que emitió; fuera de una petición no hace nada. */
export function setDocumentId(id: string): void {
  const context = storage.getStore();
  if (context !== undefined) context.documentId = id;
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}
