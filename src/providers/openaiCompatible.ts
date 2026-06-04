import { normalizeUsage } from "./usageNormalizer.js";
import type { ModelProvider, ProviderGenerateParams, ProviderGenerateResult } from "./base.js";
import { logger } from "../utils/logger.js";

interface OpenAIChoice {
  message?: {
    content?: string;
  };
  delta?: {
    content?: string;
  };
  finish_reason?: string | null;
}

interface OpenAIChatResponse {
  choices?: OpenAIChoice[];
  usage?: Record<string, unknown>;
}

interface OpenAIStreamChunk extends OpenAIChatResponse {}

export class OpenAICompatibleProvider implements ModelProvider {
  public readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(params: { id: string; baseUrl: string; apiKey?: string }) {
    this.id = params.id;
    this.baseUrl = params.baseUrl.replace(/\/$/, "");
    this.apiKey = params.apiKey ?? "local-dev";
  }

  async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
    const fn = "openaiCompatible.generate";
    const startedAt = Date.now();
    logger.info(fn, {
      providerId: this.id,
      model: params.model,
      stream: Boolean(params.stream)
    });

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        stream: Boolean(params.stream),
        stream_options: params.stream ? { include_usage: true } : undefined
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(fn, {
        providerId: this.id,
        model: params.model,
        stream: Boolean(params.stream),
        status: response.status,
        durationMs: Date.now() - startedAt
      });
      throw new Error(`Provider request failed (${response.status}): ${errorText}`);
    }

    if (params.stream) {
      const streamResult = await this.parseStreamResponse(response);
      logger.info(fn, {
        providerId: this.id,
        model: params.model,
        stream: true,
        durationMs: Date.now() - startedAt,
        contentLength: streamResult.content.length,
        hasUsage: Boolean(streamResult.usage)
      });
      return streamResult;
    }

    const json = (await response.json()) as OpenAIChatResponse;
    const content = json.choices?.[0]?.message?.content ?? "";
    const usage = normalizeUsage(json.usage);
    logger.info(fn, {
      providerId: this.id,
      model: params.model,
      stream: false,
      durationMs: Date.now() - startedAt,
      contentLength: content.length,
      hasUsage: Boolean(usage)
    });

    return {
      content,
      usage,
      raw: json
    };
  }

  private async parseStreamResponse(response: Response): Promise<ProviderGenerateResult> {
    if (!response.body) {
      throw new Error("Provider stream response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage: ReturnType<typeof normalizeUsage>;
    const chunks: OpenAIStreamChunk[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        const trimmed = event.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const payload = trimmed.replace(/^data:\s*/, "");
        if (payload === "[DONE]") {
          break;
        }

        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(payload) as OpenAIStreamChunk;
        } catch {
          continue;
        }
        chunks.push(chunk);

        const deltaText = chunk.choices?.[0]?.delta?.content ?? "";
        if (deltaText) {
          content += deltaText;
        }

        const normalized = normalizeUsage(chunk.usage);
        if (normalized) {
          usage = normalized;
        }
      }
    }

    return {
      content,
      usage,
      raw: chunks
    };
  }
}
