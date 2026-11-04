import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  consumer?: string;
  worker?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/** Adds fields to the current async context (no-op outside a context). */
export function enrichLogContext(partial: LogContext): void {
  const current = storage.getStore();
  if (current !== undefined) {
    Object.assign(current, compact(partial));
  }
}

function compact(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as LogContext;
}
