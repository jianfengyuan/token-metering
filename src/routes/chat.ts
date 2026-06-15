import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type { MeteringService } from "../metering/service.js";
import { metrics } from "../observability/metrics.js";
import { setRequestContextFields } from "../observability/requestContext.js";
import { ModelRouteNotFoundError, type ProviderGateway } from "../providers/gateway.js";
import type { AuthContext } from "../repositories/accessRepository.js";
import type { AuditRepository } from "../repositories/auditRepository.js";
import { QuotaExceededError, type QuotaRepository } from "../repositories/quotaRepository.js";
import type { UsageRepository } from "../repositories/usageRepository.js";
import { logger } from "../utils/logger.js";

const chatRequestSchema = z.object({
  userId: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
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
  quotaRepository: QuotaRepository;
  usageRepository: UsageRepository;
  auditRepository: AuditRepository;
}

function getAuthContext(res: Response): AuthContext | null {
  return (res.locals.authContext as AuthContext | undefined) ?? null;
}

function getRequestId(res: Response): string | undefined {
  return res.locals.requestId as string | undefined;
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
    const requestId = getRequestId(res);
    const authContext = getAuthContext(res);
    if (!authContext) {
      await deps.auditRepository.save({
        eventType: "auth.failed",
        outcome: "failure",
        requestId,
        method: req.method,
        path: req.originalUrl,
        errorCode: "UNAUTHORIZED",
        message: "Missing auth context"
      });
      res.status(401).json({
        error: "Missing auth context",
        code: "UNAUTHORIZED",
        requestId
      });
      return;
    }
    setRequestContextFields({
      tenantId: authContext.tenantId,
      projectId: authContext.projectId,
      apiKeyId: authContext.apiKeyId,
      userId: authContext.userId
    });

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
        requestId,
        details: parsed.error.flatten()
      });
      return;
    }

    const input = parsed.data;
    let resolvedRoute: ReturnType<ProviderGateway["resolveModelRoute"]>;
    try {
      resolvedRoute = deps.providerGateway.resolveModelRoute(input.model, input.provider);
    } catch (error) {
      const errorCode = error instanceof ModelRouteNotFoundError ? error.code : "ROUTE_RESOLVE_FAILED";
      await deps.auditRepository.save({
        eventType: "routing.failed",
        outcome: "failure",
        requestId,
        tenantId: authContext.tenantId,
        projectId: authContext.projectId,
        apiKeyId: authContext.apiKeyId,
        model: input.model,
        method: req.method,
        path: req.originalUrl,
        errorCode,
        message: error instanceof Error ? error.message : "model route resolve failed"
      });
      metrics.chatRequestsTotal.inc({
        provider: "unknown",
        model: input.model,
        outcome: "route_failed"
      });
      if (error instanceof ModelRouteNotFoundError) {
        res.status(400).json({
          error: "Model route not configured",
          code: error.code,
          requestId
        });
        return;
      }
      res.status(500).json({
        error: "Model route resolve failed",
        code: "ROUTE_RESOLVE_FAILED",
        requestId
      });
      return;
    }
    setRequestContextFields({
      provider: resolvedRoute.providerId,
      model: input.model
    });

    const meteringContext = deps.meteringService.begin({
      requestId,
      tenantId: authContext.tenantId,
      projectId: authContext.projectId,
      apiKeyId: authContext.apiKeyId,
      userId: authContext.userId,
      provider: resolvedRoute.providerId,
      model: input.model,
      messages: input.messages
    });
    const quotaReservationPlan = deps.meteringService.buildQuotaReservationPlan(meteringContext);
    const quotaReservation = {
      tenantId: authContext.tenantId,
      projectId: authContext.projectId,
      requestId: meteringContext.requestId,
      reservedTokens: quotaReservationPlan.reservedTokens,
      reservedCost: quotaReservationPlan.reservedCost
    };

    logger.info("chat.request.received", {
      requestId: meteringContext.requestId,
      tenantId: authContext.tenantId,
      projectId: authContext.projectId,
      apiKeyId: authContext.apiKeyId,
      userId: authContext.userId,
      provider: resolvedRoute.providerId,
      providerModel: resolvedRoute.providerModel,
      model: input.model,
      routeSource: resolvedRoute.source,
      fallbackProvider: resolvedRoute.fallback?.providerId,
      stream: input.stream,
      messageCount: input.messages.length
    });

    try {
      await deps.quotaRepository.reserve(quotaReservation);
    } catch (error) {
      const errorCode = error instanceof QuotaExceededError ? error.code : "QUOTA_PRECHECK_FAILED";
      const usageRecord = deps.meteringService.fail(meteringContext, errorCode);
      await deps.usageRepository.save(usageRecord);

      metrics.chatRequestsTotal.inc({
        provider: resolvedRoute.providerId,
        model: input.model,
        outcome: "quota_blocked"
      });
      await deps.auditRepository.save({
        eventType: "quota.blocked",
        outcome: "blocked",
        requestId: meteringContext.requestId,
        tenantId: authContext.tenantId,
        projectId: authContext.projectId,
        apiKeyId: authContext.apiKeyId,
        provider: resolvedRoute.providerId,
        model: input.model,
        method: req.method,
        path: req.originalUrl,
        errorCode,
        message: error instanceof Error ? error.message : "quota precheck failed",
        metadata: {
          reservedTokens: quotaReservation.reservedTokens,
          reservedCost: quotaReservation.reservedCost
        }
      });
      logger.warn("chat.request.blocked", {
        requestId: meteringContext.requestId,
        tenantId: authContext.tenantId,
        projectId: authContext.projectId,
        apiKeyId: authContext.apiKeyId,
        provider: resolvedRoute.providerId,
        model: input.model,
        errorCode
      });

      res.status(error instanceof QuotaExceededError ? 429 : 500).json({
        requestId: meteringContext.requestId,
        error: error instanceof QuotaExceededError ? "Quota exceeded" : "Quota precheck failed",
        code: errorCode
      });
      return;
    }

    let quotaSettled = false;
    try {
      if (input.stream) {
        const streamExecution = await deps.providerGateway.generateStreamWithResilience(resolvedRoute, {
          model: resolvedRoute.providerModel,
          messages: input.messages,
          stream: true
        });
        meteringContext.provider = streamExecution.providerId;
        setRequestContextFields({
          provider: streamExecution.providerId,
          model: input.model
        });
        const streamResult = streamExecution.result;

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
        await deps.usageRepository.save(usageRecord);
        await deps.quotaRepository.settleSuccess(quotaReservation, {
          totalTokens: usageRecord.totalTokensActual,
          totalCost: usageRecord.cost.totalCost
        });
        quotaSettled = true;
        if (!res.writableEnded) {
          res.end();
        }
        metrics.chatRequestsTotal.inc({
          provider: usageRecord.provider,
          model: usageRecord.model,
          outcome: "success"
        });
        logger.info("chat.request.completed", {
          requestId: usageRecord.requestId,
          provider: usageRecord.provider,
          model: usageRecord.model,
          providerModel: streamExecution.providerModel,
          attempts: streamExecution.attempts,
          retries: streamExecution.retries,
          failoverUsed: streamExecution.failoverUsed,
          latencyMs: usageRecord.latencyMs,
          promptTokens: usageRecord.promptTokensActual,
          completionTokens: usageRecord.completionTokensActual,
          totalTokens: usageRecord.totalTokensActual,
          totalCost: usageRecord.cost.totalCost,
          stream: true
        });
        return;
      }

      const generation = await deps.providerGateway.generateWithResilience(resolvedRoute, {
        model: resolvedRoute.providerModel,
        messages: input.messages,
        stream: false
      });
      meteringContext.provider = generation.providerId;
      setRequestContextFields({
        provider: generation.providerId,
        model: input.model
      });
      const result = generation.result;

      const usageRecord = deps.meteringService.finalize(meteringContext, {
        completionText: result.content,
        reasoningText: result.reasoning,
        providerUsage: result.usage
      });
      await deps.usageRepository.save(usageRecord);
      await deps.quotaRepository.settleSuccess(quotaReservation, {
        totalTokens: usageRecord.totalTokensActual,
        totalCost: usageRecord.cost.totalCost
      });
      quotaSettled = true;
      metrics.chatRequestsTotal.inc({
        provider: usageRecord.provider,
        model: usageRecord.model,
        outcome: "success"
      });
      logger.info("chat.request.completed", {
        requestId: usageRecord.requestId,
        provider: usageRecord.provider,
        model: usageRecord.model,
        providerModel: generation.providerModel,
        attempts: generation.attempts,
        retries: generation.retries,
        failoverUsed: generation.failoverUsed,
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
      if (!quotaSettled) {
        await deps.quotaRepository.rollback(quotaReservation);
      }
      const usageRecord = deps.meteringService.fail(
        meteringContext,
        error instanceof Error ? error.message : "provider_error"
      );
      await deps.usageRepository.save(usageRecord);
      metrics.chatRequestsTotal.inc({
        provider: usageRecord.provider,
        model: usageRecord.model,
        outcome: "provider_failed"
      });
      await deps.auditRepository.save({
        eventType: "routing.failed",
        outcome: "failure",
        requestId: usageRecord.requestId,
        tenantId: authContext.tenantId,
        projectId: authContext.projectId,
        apiKeyId: authContext.apiKeyId,
        provider: usageRecord.provider,
        model: usageRecord.model,
        method: req.method,
        path: req.originalUrl,
        errorCode: usageRecord.errorCode,
        message: "Provider call failed"
      });
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
