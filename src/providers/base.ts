import type { ChatMessage, UsageBreakdown } from "../metering/types.js";

export interface ProviderGenerateParams {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
}

export interface ProviderGenerateResult {
  content: string;
  reasoning?: string;
  usage?: Partial<UsageBreakdown>;
  raw: unknown;
}

export interface ProviderStreamResult {
  stream: ReadableStream<Uint8Array>;
  completion: Promise<ProviderGenerateResult>;
  contentType?: string;
}

export interface ModelProvider {
  readonly id: string;
  generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult>;
  generateStream(params: ProviderGenerateParams): Promise<ProviderStreamResult>;
}
