import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type { MeteringService } from "../metering/service.js";
import type { ProviderGateway } from "../providers/gateway.js";
import type { UsageRepository } from "../repositories/usageRepository.js";
import { logger } from "../utils/logger.js";

const chatRequestSchema = z.object({
  userId: z.string().min(1),
  provider: z.string().min(1).default("local-simulator"),
  model: z.string().min(1).default("sim-local"),
  stream: z.boolean().optional().default(true),
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

async function pipeProviderStreamToResponse(
  req: Request,
  res: Response,
  stream: ReadableStream<Uint8Array>
): Promise<void> {
  const reader = stream.getReader();
  const handleAbort = () => {
    void reader.cancel("client disconnected");
  };
  req.on("aborted", handleAbort);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.byteLength > 0) {
        res.write(Buffer.from(value));
      }
    }
  } finally {
    req.off("aborted", handleAbort);
    reader.releaseLock();
  }
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
      if (input.stream) {
        const streamResult = await deps.providerGateway.generateStream(input.provider, {
          model: input.model,
          messages: input.messages,
          stream: true
        });

        res.setHeader("Content-Type", streamResult.contentType ?? "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        if (typeof res.flushHeaders === "function") {
          res.flushHeaders();
        }

        await pipeProviderStreamToResponse(req, res, streamResult.stream);
        const result = await streamResult.completion;
        const usageRecord = deps.meteringService.finalize(meteringContext, {
          completionText: result.content,
          reasoningText: result.reasoning,
          providerUsage: result.usage
        });
        deps.usageRepository.save(usageRecord);
        if (!res.writableEnded) {
          res.end();
        }
        logger.info("chat.request.completed", {
          requestId: usageRecord.requestId,
          provider: usageRecord.provider,
          model: usageRecord.model,
          latencyMs: usageRecord.latencyMs,
          promptTokens: usageRecord.promptTokensActual,
          completionTokens: usageRecord.completionTokensActual,
          totalTokens: usageRecord.totalTokensActual,
          totalCost: usageRecord.cost.totalCost,
          stream: true
        });
        return;
      }

      const result = await deps.providerGateway.generate(input.provider, {
        model: input.model,
        messages: input.messages,
        stream: false
      });

      const usageRecord = deps.meteringService.finalize(meteringContext, {
        completionText: result.content,
        reasoningText: result.reasoning,
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
        totalCost: usageRecord.cost.totalCost,
        stream: false
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
        errorCode: usageRecord.errorCode,
        stream: input.stream
      });

      if (!res.headersSent) {
        res.status(502).json({
          requestId: usageRecord.requestId,
          error: "Provider call failed",
          details: usageRecord.errorCode
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return router;
}
