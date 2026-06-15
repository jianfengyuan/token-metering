import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { runWithRequestContext } from "../observability/requestContext.js";

function nonEmpty(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createRequestContextMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const inheritedRequestId = nonEmpty(req.header("x-request-id")) ?? nonEmpty(req.header("x-trace-id"));
    const requestId = inheritedRequestId ?? randomUUID();
    const traceId = requestId;

    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-trace-id", traceId);

    runWithRequestContext(
      {
        requestId,
        traceId,
        method: req.method,
        path: req.path
      },
      () => next()
    );
  };
}
