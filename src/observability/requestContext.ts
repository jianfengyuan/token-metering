import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  traceId: string;
  method?: string;
  path?: string;
  tenantId?: string;
  projectId?: string;
  apiKeyId?: string;
  userId?: string;
  provider?: string;
  model?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

function cleanUndefinedFields<T extends Record<string, unknown>>(input: T): Partial<T> {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<T>;
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function setRequestContextFields(fields: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (!current) {
    return;
  }
  Object.assign(current, cleanUndefinedFields(fields));
}
