import type { ChatMessage } from "./types.js";

function roughTokenCount(text: string): number {
  if (!text.trim()) {
    return 0;
  }

  // A practical fallback estimator for framework phase.
  return Math.ceil(text.length / 4);
}

export function estimatePromptTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    return total + roughTokenCount(`${message.role}:${message.content}`);
  }, 0);
}

export function estimateCompletionTokens(completionText: string): number {
  return roughTokenCount(completionText);
}
