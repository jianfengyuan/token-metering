import { estimateCompletionTokens } from "../metering/tokenizer.js";
import { estimatePromptTokens } from "../metering/tokenizer.js";
import type {
  ModelProvider,
  ProviderGenerateParams,
  ProviderGenerateResult,
  ProviderStreamResult
} from "./base.js";

export class MockLocalProvider implements ModelProvider {
  public readonly id = "local-mock";

  async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
    const prompt = params.messages.at(-1)?.content ?? "";
    const content = `Mock response: ${prompt.slice(0, 120)}`;
    const promptTokens = estimatePromptTokens(params.model, params.messages);
    const completionTokens = estimateCompletionTokens(params.model, content);

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

  async generateStream(params: ProviderGenerateParams): Promise<ProviderStreamResult> {
    const result = await this.generate(params);
    const encoder = new TextEncoder();
    const chunks = result.content.split(" ");
    const usagePayload = {
      prompt_tokens: result.usage?.promptTokens ?? 0,
      completion_tokens: result.usage?.completionTokens ?? 0,
      total_tokens: result.usage?.totalTokens ?? 0
    };

    return {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            if (!chunk) {
              continue;
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: `mock-${Date.now()}`,
                  object: "chat.completion.chunk",
                  model: params.model,
                  choices: [{ index: 0, delta: { content: `${chunk} ` }, finish_reason: null }]
                })}\n\n`
              )
            );
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: `mock-${Date.now()}`,
                object: "chat.completion.chunk",
                model: params.model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: usagePayload
              })}\n\n`
            )
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }),
      completion: Promise.resolve(result),
      contentType: "text/event-stream; charset=utf-8"
    };
  }
}
