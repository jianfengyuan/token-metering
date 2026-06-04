import { describe, expect, it } from "vitest";
import { normalizeUsage } from "../src/providers/usageNormalizer.js";

describe("normalizeUsage", () => {
  it("normalizes OpenAI usage", () => {
    const usage = normalizeUsage({
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19
    });

    expect(usage).toEqual({
      promptTokens: 12,
      completionTokens: 7,
      totalTokens: 19
    });
  });

  it("normalizes Ollama usage-like fields", () => {
    const usage = normalizeUsage({
      prompt_eval_count: 10,
      eval_count: 8
    });

    expect(usage).toEqual({
      promptTokens: 10,
      completionTokens: 8,
      totalTokens: 18
    });
  });
});
