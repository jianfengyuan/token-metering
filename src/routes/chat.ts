import { Router } from "express";
import { z } from "zod";
import type { MeteringService } from "../metering/service.js";
import type { ProviderGateway } from "../providers/gateway.js";
import type { UsageRepository } from "../repositories/usageRepository.js";
import { logger } from "../utils/logger.js";

const chatRequestSchema = z.object({
  userId: z.string().min(1),
  provider: z.string().min(1).default("local-simulator"),
  model: z.string().min(1).default("sim-local"),
  stream: z.boolean().optional().default(false),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string()
      })
    )
    .min(1)
});

interface ChatRouterDeps {
  meteringService: MeteringService;
  providerGateway: ProviderGateway;
  usageRepository: UsageRepository;
}

export function createChatRouter(deps: ChatRouterDeps): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn("chat.request.invalid", {
        route: "/chat",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten()
      });
      return;
    }

    const input = parsed.data;
    const meteringContext = deps.meteringService.begin({
      userId: input.userId,
      provider: input.provider,
      model: input.model,
      messages: input.messages
    });
    logger.info("chat.request.received", {
      requestId: meteringContext.requestId,
      userId: input.userId,
      provider: input.provider,
      model: input.model,
      stream: input.stream,
      messageCount: input.messages.length
    });

    try {
      const result = await deps.providerGateway.generate(input.provider, {
        model: input.model,
        messages: input.messages,
        stream: input.stream
      });

      const usageRecord = deps.meteringService.finalize(meteringContext, {
        completionText: result.content,
        providerUsage: result.usage
      });
      deps.usageRepository.save(usageRecord);
      logger.info("chat.request.completed", {
        requestId: usageRecord.requestId,
        provider: usageRecord.provider,
        model: usageRecord.model,
        latencyMs: usageRecord.latencyMs,
        promptTokens: usageRecord.promptTokensActual,
        completionTokens: usageRecord.completionTokensActual,
        totalTokens: usageRecord.totalTokensActual,
        totalCost: usageRecord.cost.totalCost
      });

      res.json({
        requestId: usageRecord.requestId,
        output: result.content,
        usage: usageRecord.usage,
        cost: usageRecord.cost
      });
    } catch (error) {
      const usageRecord = deps.meteringService.fail(
        meteringContext,
        error instanceof Error ? error.message : "provider_error"
      );
      deps.usageRepository.save(usageRecord);
      logger.error("chat.request.failed", {
        requestId: usageRecord.requestId,
        provider: usageRecord.provider,
        model: usageRecord.model,
        latencyMs: usageRecord.latencyMs,
        errorCode: usageRecord.errorCode
      });

      res.status(502).json({
        requestId: usageRecord.requestId,
        error: "Provider call failed",
        details: usageRecord.errorCode
      });
    }
  });

  return router;
}
