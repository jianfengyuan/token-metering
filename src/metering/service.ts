import { v4 as uuidv4 } from "uuid";
import { calculateCost } from "./cost.js";
import { estimateCompletionTokens, estimatePromptTokens } from "./tokenizer.js";
import type { MeteringContext, MeteringFinalizeInput, MeteringStartInput, UsageRecord } from "./types.js";

export class MeteringService {
  begin(input: MeteringStartInput): MeteringContext {
    const now = Date.now();
    return {
      requestId: uuidv4(),
      userId: input.userId,
      provider: input.provider,
      model: input.model,
      startedAtMs: now,
      createdAt: new Date(now).toISOString(),
      estimatedPromptTokens: estimatePromptTokens(input.messages)
    };
  }

  finalize(context: MeteringContext, input: MeteringFinalizeInput): UsageRecord {
    const estimatedCompletionTokens = estimateCompletionTokens(input.completionText);
    const promptTokensActual = input.providerUsage?.promptTokens ?? context.estimatedPromptTokens;
    const completionTokensActual = input.providerUsage?.completionTokens ?? estimatedCompletionTokens;
    const totalTokensActual = input.providerUsage?.totalTokens ?? promptTokensActual + completionTokensActual;
    const cost = calculateCost(context.model, promptTokensActual, completionTokensActual);

    return {
      requestId: context.requestId,
      userId: context.userId,
      provider: context.provider,
      model: context.model,
      promptTokensEstimated: context.estimatedPromptTokens,
      completionTokensEstimated: estimatedCompletionTokens,
      promptTokensActual,
      completionTokensActual,
      totalTokensActual,
      usage: {
        promptTokens: promptTokensActual,
        completionTokens: completionTokensActual,
        totalTokens: totalTokensActual
      },
      cost,
      latencyMs: Date.now() - context.startedAtMs,
      status: "success",
      createdAt: context.createdAt
    };
  }

  fail(context: MeteringContext, errorCode: string): UsageRecord {
    const cost = calculateCost(context.model, 0, 0);
    return {
      requestId: context.requestId,
      userId: context.userId,
      provider: context.provider,
      model: context.model,
      promptTokensEstimated: context.estimatedPromptTokens,
      completionTokensEstimated: 0,
      promptTokensActual: 0,
      completionTokensActual: 0,
      totalTokensActual: 0,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      },
      cost,
      latencyMs: Date.now() - context.startedAtMs,
      status: "failed",
      errorCode,
      createdAt: context.createdAt
    };
  }
}
