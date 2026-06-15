import type { NextFunction, Request, Response } from "express";
import { metrics } from "../observability/metrics.js";

function resolveRouteLabel(req: Request): string {
  const base = req.baseUrl || "";
  const routePath = typeof req.route?.path === "string" ? req.route.path : req.path;
  const combined = `${base}${routePath || ""}`;
  return combined || "/";
}

export function createHttpMetricsMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();

    res.once("finish", () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const route = resolveRouteLabel(req);
      metrics.httpRequestsTotal.inc({
        method: req.method,
        route,
        status: res.statusCode
      });
      metrics.httpRequestDurationMs.observe(elapsedMs, {
        method: req.method,
        route
      });
    });

    next();
  };
}
