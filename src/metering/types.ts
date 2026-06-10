export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface UsageBreakdown {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CostBreakdown {
  currency: string;
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

export type UsageStatus = "success" | "failed";
export type TokenizerType = "huggingface" | "tiktoken";

export interface UsageRecord {
  requestId: string;
  userId: string;
  provider: string;
  model: string;
  tokenizerType: TokenizerType;
  promptTokensEstimated: number;
  completionTokensEstimated: number;
  promptTokensActual: number;
  completionTokensActual: number;
  totalTokensActual: number;
  usage: UsageBreakdown;
  cost: CostBreakdown;
  latencyMs: number;
  status: UsageStatus;
  errorCode?: string;
  createdAt: string;
}

export interface MeteringStartInput {
  userId: string;
  provider: string;
  model: string;
  messages: ChatMessage[];
}

export interface MeteringContext {
  requestId: string;
  userId: string;
  provider: string;
  model: string;
  startedAtMs: number;
  createdAt: string;
  estimatedPromptTokens: number;
  tokenizerType: TokenizerType;
}

export interface MeteringFinalizeInput {
  completionText: string;
  reasoningText?: string;
  providerUsage?: Partial<UsageBreakdown>;
}
