import { describe, expect, it } from "vitest";
import { MeteringService } from "../src/metering/service.js";

describe("MeteringService", () => {
  it("uses provider usage when available", () => {
    const service = new MeteringService();
    const context = service.begin({
      userId: "u1",
      provider: "local-ollama",
      model: "llama3.2",
      messages: [{ role: "user", content: "hello" }]
    });

    const record = service.finalize(context, {
      completionText: "response",
      providerUsage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15
      }
    });

    expect(record.promptTokensActual).toBe(10);
    expect(record.completionTokensActual).toBe(5);
    expect(record.totalTokensActual).toBe(15);
    expect(record.status).toBe("success");
  });

  it("falls back to local estimate when provider usage missing", () => {
    const service = new MeteringService();
    const context = service.begin({
      userId: "u1",
      provider: "local-ollama",
      model: "llama3.2",
      messages: [{ role: "user", content: "hello world" }]
    });

    const record = service.finalize(context, {
      completionText: "fallback text"
    });

    expect(record.promptTokensActual).toBeGreaterThan(0);
    expect(record.completionTokensActual).toBeGreaterThan(0);
    expect(record.totalTokensActual).toBe(record.promptTokensActual + record.completionTokensActual);
  });
});
