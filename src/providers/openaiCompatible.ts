import { normalizeUsage } from "./usageNormalizer.js";
import type {
  ModelProvider,
  ProviderGenerateParams,
  ProviderGenerateResult,
  ProviderStreamResult
} from "./base.js";
import { logger } from "../utils/logger.js";

interface OpenAIChoice {
  message?: {
    content?: string;
    reasoning?: string;
    reasoning_content?: string;
  };
  delta?: {
    content?: string;
    reasoning?: string;
    reasoning_content?: string;
  };
  finish_reason?: string | null;
}

interface OpenAIChatResponse {
  choices?: OpenAIChoice[];
  usage?: Record<string, unknown>;
}

interface OpenAIStreamChunk extends OpenAIChatResponse {}

function extractReasoning(choice?: OpenAIChoice): string {
  return (
    choice?.delta?.reasoning ??
    choice?.delta?.reasoning_content ??
    choice?.message?.reasoning ??
    choice?.message?.reasoning_content ??
    ""
  );
}

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
      provider: this.id,
      model: params.model,
      stream: false
    });

    const response = await this.requestChatCompletion(params, false);

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(fn, {
        providerId: this.id,
        provider: this.id,
        model: params.model,
        stream: false,
        status: response.status,
        durationMs: Date.now() - startedAt
      });
      throw new Error(`Provider request failed (${response.status}): ${errorText}`);
    }

    const json = (await response.json()) as OpenAIChatResponse;
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? "";
    const reasoning = extractReasoning(choice);
    const usage = normalizeUsage(json.usage);
    logger.info(fn, {
      providerId: this.id,
      provider: this.id,
      model: params.model,
      stream: false,
      durationMs: Date.now() - startedAt,
      contentLength: content.length,
      reasoningLength: reasoning.length,
      hasUsage: Boolean(usage)
    });

    return {
      content,
      reasoning: reasoning || undefined,
      usage,
      raw: json
    };
  }

  async generateStream(params: ProviderGenerateParams): Promise<ProviderStreamResult> {
    const fn = "openaiCompatible.generateStream";
    const startedAt = Date.now();
    logger.info(fn, {
      providerId: this.id,
      provider: this.id,
      model: params.model,
      stream: true
    });

    const response = await this.requestChatCompletion(params, true);
    if (!response.ok) {
      const errorText = await response.text();
      logger.error(fn, {
        providerId: this.id,
        provider: this.id,
        model: params.model,
        stream: true,
        status: response.status,
        durationMs: Date.now() - startedAt
      });
      throw new Error(`Provider request failed (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error("Provider stream response has no body");
    }

    const [passthroughStream, parseStream] = response.body.tee();
    const completion = this.parseStreamResponse(parseStream)
      .then((result) => {
        logger.info(fn, {
          providerId: this.id,
          provider: this.id,
          model: params.model,
          stream: true,
          durationMs: Date.now() - startedAt,
          contentLength: result.content.length,
          hasUsage: Boolean(result.usage)
        });
        return result;
      })
      .catch((error) => {
        logger.error(fn, {
          providerId: this.id,
          provider: this.id,
          model: params.model,
          stream: true,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : "stream_parse_failed"
        });
        throw error;
      });

    return {
      stream: passthroughStream,
      completion,
      contentType: response.headers.get("content-type") ?? undefined
    };
  }

  private async requestChatCompletion(params: ProviderGenerateParams, stream: boolean): Promise<Response> {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      signal: params.signal,
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        stream,
        stream_options: stream ? { include_usage: true } : undefined
      })
    });
  }

  private parseStreamEventPayload(event: string): string | undefined {
    const dataLines = event
      .split("\n")
      .map((line) => line.trimStart())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s*/, ""));

    if (dataLines.length === 0) {
      return undefined;
    }

    return dataLines.join("\n");
  }

  private async parseStreamResponse(stream: ReadableStream<Uint8Array>): Promise<ProviderGenerateResult> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let usage: ReturnType<typeof normalizeUsage>;
    let chunkCount = 0;
    let doneSeen = false;

    const consumeEvent = (eventText: string): boolean => {
      const payload = this.parseStreamEventPayload(eventText);
      if (!payload) {
        return false;
      }
      if (payload === "[DONE]") {
        return true;
      }

      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(payload) as OpenAIStreamChunk;
      } catch {
        return false;
      }

      chunkCount += 1;
      const deltaText = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
      if (deltaText) {
        content += deltaText;
      }
      const deltaReasoning = extractReasoning(chunk.choices?.[0]);
      if (deltaReasoning) {
        reasoning += deltaReasoning;
      }
      const normalizedUsage = normalizeUsage(chunk.usage);
      if (normalizedUsage) {
        usage = normalizedUsage;
      }
      return false;
    };

    while (!doneSeen) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        if (consumeEvent(event)) {
          doneSeen = true;
          break;
        }
      }
    }

    buffer += decoder.decode();
    if (!doneSeen && buffer.trim()) {
      consumeEvent(buffer);
    }

    return {
      content,
      reasoning: reasoning || undefined,
      usage,
      raw: {
        chunkCount
      }
    };
  }
}
