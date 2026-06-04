import type { ChatMessage, UsageBreakdown } from "../metering/types.js";

export interface ProviderGenerateParams {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
}

export interface ProviderGenerateResult {
  content: string;
  usage?: Partial<UsageBreakdown>;
  raw: unknown;
}

export interface ModelProvider {
  readonly id: string;
  generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult>;
}
