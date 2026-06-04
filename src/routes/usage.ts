import { Router } from "express";
import { z } from "zod";
import type { UsageRepository } from "../repositories/usageRepository.js";
import { logger } from "../utils/logger.js";

const querySchema = z.object({
  userId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

export function createUsageRouter(usageRepository: UsageRepository): Router {
  const router = Router();

  router.get("/", (req, res) => {
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
        details: parsed.error.flatten()
      });
      return;
    }

    const query = parsed.data;
    const records = usageRepository.list(query);
    const summary = usageRepository.summary(query);
    const daily = usageRepository.daily(query);
    logger.info("usage.query.completed", {
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
