import { Router } from "express";
import { z } from "zod";
import { estimateCompletionTokens, estimatePromptTokens } from "../metering/tokenizer.js";
import type { ChatMessage } from "../metering/types.js";

const simulatorRequestSchema = z.object({
  model: z.string().min(1).default("sim-local"),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string()
      })
    )
    .min(1),
  stream: z.boolean().optional().default(false)
});

const embeddingRequestSchema = z.object({
  model: z.string().min(1).default("sim-local-embedding"),
  input: z.union([z.string(), z.array(z.string()).min(1)])
});

function buildCompletion(messages: ChatMessage[]): string {
  const prompt = messages.at(-1)?.content ?? "";
  return `Local simulated response: ${prompt.slice(0, 180)}`;
}

export function createSimulatorRouter(): Router {
  const router = Router();

  router.post("/chat/completions", async (req, res) => {
    const parsed = simulatorRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid simulator request",
        details: parsed.error.flatten()
      });
      return;
    }

    const input = parsed.data;
    const content = buildCompletion(input.messages);
    const promptTokens = estimatePromptTokens(input.messages);
    const completionTokens = estimateCompletionTokens(content);
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    };

    if (!input.stream) {
      res.json({
        id: `sim-${Date.now()}`,
        object: "chat.completion",
        model: input.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content
            },
            finish_reason: "stop"
          }
        ],
        usage
      });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const parts = content.split(" ");
    for (const part of parts) {
      const payload = {
        id: `sim-${Date.now()}`,
        object: "chat.completion.chunk",
        model: input.model,
        choices: [
          {
            index: 0,
            delta: {
              content: `${part} `
            },
            finish_reason: null
          }
        ]
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    res.write(
      `data: ${JSON.stringify({
        id: `sim-${Date.now()}`,
        object: "chat.completion.chunk",
        model: input.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage
      })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });

  router.post("/embeddings", (req, res) => {
    const parsed = embeddingRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid embeddings request",
        details: parsed.error.flatten()
      });
      return;
    }

    const input = parsed.data;
    const inputs = Array.isArray(input.input) ? input.input : [input.input];
    const data = inputs.map((value, index) => ({
      object: "embedding",
      index,
      embedding: Array.from({ length: 8 }, (_, i) => (value.length + i) / 100)
    }));

    res.json({
      object: "list",
      model: input.model,
      data,
      usage: {
        prompt_tokens: inputs.reduce((sum, text) => sum + estimateCompletionTokens(text), 0),
        total_tokens: inputs.reduce((sum, text) => sum + estimateCompletionTokens(text), 0)
      }
    });
  });

  return router;
}
