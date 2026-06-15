import { Router } from "express";
import { z } from "zod";
import type { AuthContext } from "../repositories/accessRepository.js";
import type { UsageRepository } from "../repositories/usageRepository.js";
import { logger } from "../utils/logger.js";

const querySchema = z.object({
  projectId: z.string().optional(),
  userId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

export function createUsageRouter(usageRepository: UsageRepository): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const authContext = (res.locals.authContext as AuthContext | undefined) ?? null;
    if (!authContext) {
      res.status(401).json({
        error: "Missing auth context",
        code: "UNAUTHORIZED",
        requestId
      });
      return;
    }

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      logger.warn("usage.query.invalid", {
        route: "/usage",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      res.status(400).json({
        error: "Invalid query parameters",
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    const query = parsed.data;
    const scopedQuery = {
      tenantId: authContext.tenantId,
      projectId: authContext.authType === "api_key" ? authContext.projectId : query.projectId ?? authContext.projectId,
      userId: query.userId,
      provider: query.provider,
      model: query.model,
      from: query.from,
      to: query.to
    };
    const records = await usageRepository.list(scopedQuery);
    const summary = await usageRepository.summary(scopedQuery);
    const daily = await usageRepository.daily(scopedQuery);
    logger.info("usage.query.completed", {
      tenantId: authContext.tenantId,
      projectId: scopedQuery.projectId,
      userId: query.userId,
      provider: query.provider,
      model: query.model,
      from: query.from,
      to: query.to,
      recordCount: records.length,
      dailyCount: daily.length,
      totalTokens: summary.totalTokens,
      totalCost: summary.totalCost
    });

    res.json({
      summary,
      daily,
      records
    });
  });

  return router;
}
