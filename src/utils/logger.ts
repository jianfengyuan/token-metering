type LogLevel = "INFO" | "WARN" | "ERROR";

type LogMeta = Record<string, unknown>;

import { getRequestContext } from "../observability/requestContext.js";

function contextLogMeta(): LogMeta {
  const context = getRequestContext();
  if (!context) {
    return {};
  }

  return {
    requestId: context.requestId,
    traceId: context.traceId,
    tenantId: context.tenantId,
    projectId: context.projectId,
    apiKeyId: context.apiKeyId,
    userId: context.userId,
    provider: context.provider,
    model: context.model
  };
}

function emit(level: LogLevel, message: string, meta: LogMeta = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...contextLogMeta(),
    ...meta
  };
  const line = JSON.stringify(payload);

  if (level === "ERROR") {
    console.error(line);
    return;
  }

  if (level === "WARN") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export const logger = {
  info(message: string, meta?: LogMeta) {
    emit("INFO", message, meta);
  },
  warn(message: string, meta?: LogMeta) {
    emit("WARN", message, meta);
  },
  error(message: string, meta?: LogMeta) {
    emit("ERROR", message, meta);
  }
};
