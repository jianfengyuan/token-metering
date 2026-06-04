import { estimateCompletionTokens } from "../metering/tokenizer.js";
import { estimatePromptTokens } from "../metering/tokenizer.js";
import type { ModelProvider, ProviderGenerateParams, ProviderGenerateResult } from "./base.js";

export class MockLocalProvider implements ModelProvider {
  public readonly id = "local-mock";

  async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
    const prompt = params.messages.at(-1)?.content ?? "";
    const content = `Mock response: ${prompt.slice(0, 120)}`;
    const promptTokens = estimatePromptTokens(params.messages);
    const completionTokens = estimateCompletionTokens(content);

    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
      },
      raw: {
        source: "mock"
      }
    };
  }
}
