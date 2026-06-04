import { getModelPricing } from "../config/models.js";
import type { CostBreakdown } from "./types.js";

const TOKENS_PER_MILLION = 1_000_000;

export function calculateCost(model: string, promptTokens: number, completionTokens: number): CostBreakdown {
  const pricing = getModelPricing(model);
  const inputCost = (promptTokens / TOKENS_PER_MILLION) * pricing.inputPerMillion;
  const outputCost = (completionTokens / TOKENS_PER_MILLION) * pricing.outputPerMillion;

  return {
    currency: pricing.currency,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost
  };
}
