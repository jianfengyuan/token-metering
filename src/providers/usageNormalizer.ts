import type { UsageBreakdown } from "../metering/types.js";

interface OpenAIUsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OllamaUsageShape {
  prompt_eval_count?: number;
  eval_count?: number;
}

type UnknownUsage = OpenAIUsageShape & OllamaUsageShape & Record<string, unknown>;

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeUsage(usage?: UnknownUsage): Partial<UsageBreakdown> | undefined {
  if (!usage) {
    return undefined;
  }

  const promptTokens = toNumber(usage.prompt_tokens) ?? toNumber(usage.prompt_eval_count);
  const completionTokens = toNumber(usage.completion_tokens) ?? toNumber(usage.eval_count);
  const totalTokens = toNumber(usage.total_tokens);

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0)
  };
}
