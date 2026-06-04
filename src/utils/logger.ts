type LogLevel = "INFO" | "WARN" | "ERROR";

type LogMeta = Record<string, unknown>;

function emit(level: LogLevel, message: string, meta: LogMeta = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
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
