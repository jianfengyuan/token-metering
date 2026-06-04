import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("App integration", () => {
  beforeEach(() => {
    process.env.DATABASE_PATH = ":memory:";
    process.env.PORT = "3000";
  });

  it("records chat usage and returns usage summary", async () => {
    const app = createApp();

    const chatResponse = await request(app).post("/chat").send({
      userId: "u1",
      provider: "local-mock",
      model: "sim-local",
      messages: [{ role: "user", content: "hello token metering" }]
    });

    expect(chatResponse.status).toBe(200);
    expect(chatResponse.body.requestId).toBeTypeOf("string");
    expect(chatResponse.body.usage.totalTokens).toBeGreaterThan(0);

    const usageResponse = await request(app).get("/usage").query({ userId: "u1" });
    expect(usageResponse.status).toBe(200);
    expect(usageResponse.body.summary.count).toBe(1);
    expect(usageResponse.body.records).toHaveLength(1);
    expect(usageResponse.body.daily.length).toBeGreaterThan(0);
  });

  it("serves local simulator openai compatible response", async () => {
    const app = createApp();
    const response = await request(app).post("/simulator/v1/chat/completions").send({
      model: "sim-local",
      messages: [{ role: "user", content: "simulate openai response" }],
      stream: false
    });

    expect(response.status).toBe(200);
    expect(response.body.object).toBe("chat.completion");
    expect(response.body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(response.body.choices[0].message.content).toContain("Local simulated response");
  });

  it("serves simulator streaming chunks", async () => {
    const app = createApp();
    const response = await request(app).post("/simulator/v1/chat/completions").send({
      model: "sim-local",
      messages: [{ role: "user", content: "stream me" }],
      stream: true
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain("data:");
    expect(response.text).toContain("[DONE]");
  });
});
