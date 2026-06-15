import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { metrics } from "../src/observability/metrics.js";
import { AccessRepository, FALLBACK_API_KEY } from "../src/repositories/accessRepository.js";
import { AuditRepository } from "../src/repositories/auditRepository.js";

function ensurePostgresEnv(): void {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://admin:admin@127.0.0.1:5432/token_metering";
}

describe("App integration", () => {
  beforeEach(() => {
    process.env.DATABASE_CLIENT = "postgres";
    ensurePostgresEnv();
    process.env.PORT = "3000";
    process.env.ALLOW_LEGACY_AUTH = "true";
    metrics.resetForTests();
  });

  it("keeps legacy compatibility and records usage", async () => {
    const app = await createApp();

    const chatResponse = await request(app).post("/chat").send({
      userId: "u1",
      model: "mock-default",
      stream: false,
      messages: [{ role: "user", content: "hello token metering" }]
    });

    expect(chatResponse.status).toBe(200);
    expect(chatResponse.body.requestId).toBeTypeOf("string");
    expect(chatResponse.headers["x-request-id"]).toBe(chatResponse.body.requestId);
    expect(chatResponse.body.usage.totalTokens).toBeGreaterThan(0);

    const usageResponse = await request(app).get("/usage").query({ userId: "u1" });
    expect(usageResponse.status).toBe(200);
    expect(usageResponse.body.summary.count).toBe(1);
    expect(usageResponse.body.records).toHaveLength(1);
    expect(usageResponse.body.daily.length).toBeGreaterThan(0);
  });

  it("streams chat by default and still records usage", async () => {
    const app = await createApp();

    const chatResponse = await request(app).post("/chat").send({
      userId: "u-stream",
      provider: "local-simulator",
      model: "mock-default",
      messages: [{ role: "user", content: "stream this response" }]
    });

    expect(chatResponse.status).toBe(200);
    expect(chatResponse.headers["content-type"]).toContain("text/event-stream");
    expect(chatResponse.text).toContain("data:");
    expect(chatResponse.text).toContain("[DONE]");

    const usageResponse = await request(app).get("/usage").query({ userId: "u-stream" });
    expect(usageResponse.status).toBe(200);
    expect(usageResponse.body.summary.count).toBe(1);
  });

  it("rejects invalid api key when legacy mode disabled", async () => {
    const app = await createApp({ allowLegacyAuth: false });
    const response = await request(app)
      .post("/chat")
      .set("Authorization", "Bearer invalid-key")
      .send({
        model: "sim-local",
        stream: false,
        messages: [{ role: "user", content: "auth test" }]
      });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("INVALID_API_KEY");
  });

  it("blocks request when project quota exceeded", async () => {
    const db = await createDatabase();
    const accessRepository = new AccessRepository(db);
    const tenant = await accessRepository.createTenantProjectApiKey({
      tenantId: "tenant-small",
      projectId: "project-small",
      apiKey: "tm_small_quota",
      tokenLimit: 10,
      costLimit: 10
    });
    const app = await createApp({ database: db, allowLegacyAuth: false });

    const response = await request(app)
      .post("/chat")
      .set("Authorization", `Bearer ${tenant.apiKey}`)
      .send({
        model: "mock-default",
        stream: false,
        messages: [{ role: "user", content: "quota check should block" }]
      });

    expect(response.status).toBe(429);
    expect(response.body.code).toBe("QUOTA_EXCEEDED");
  });

  it("isolates usage by tenant api key", async () => {
    const db = await createDatabase();
    const accessRepository = new AccessRepository(db);
    const tenantA = await accessRepository.createTenantProjectApiKey({
      tenantId: "tenant-a",
      projectId: "project-a",
      apiKey: "tm_tenant_a"
    });
    const tenantB = await accessRepository.createTenantProjectApiKey({
      tenantId: "tenant-b",
      projectId: "project-b",
      apiKey: "tm_tenant_b"
    });
    const app = await createApp({ database: db, allowLegacyAuth: false });

    await request(app)
      .post("/chat")
      .set("Authorization", `Bearer ${tenantA.apiKey}`)
      .send({
        model: "mock-default",
        stream: false,
        messages: [{ role: "user", content: "tenant A usage" }]
      });

    await request(app)
      .post("/chat")
      .set("Authorization", `Bearer ${tenantB.apiKey}`)
      .send({
        model: "mock-default",
        stream: false,
        messages: [{ role: "user", content: "tenant B usage" }]
      });

    const usageA = await request(app).get("/usage").set("Authorization", `Bearer ${tenantA.apiKey}`);
    expect(usageA.status).toBe(200);
    expect(usageA.body.summary.count).toBe(1);
    expect(usageA.body.records).toHaveLength(1);
    expect(usageA.body.records[0].tenantId).toBe("tenant-a");
  });

  it("chooses platform model route over client provider override", async () => {
    const app = await createApp({ allowLegacyAuth: false });
    const response = await request(app)
      .post("/chat")
      .set("Authorization", `Bearer ${FALLBACK_API_KEY}`)
      .send({
        model: "mock-default",
        provider: "local-simulator",
        stream: false,
        messages: [{ role: "user", content: "route by model" }]
      });

    expect(response.status).toBe(200);
    const usage = await request(app).get("/usage").set("Authorization", `Bearer ${FALLBACK_API_KEY}`);
    expect(usage.status).toBe(200);
    expect(usage.body.records[0].provider).toBe("local-mock");
  });

  it("serves local simulator openai compatible response", async () => {
    const app = await createApp();
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
    const app = await createApp();
    const response = await request(app).post("/simulator/v1/chat/completions").send({
      model: "sim-local",
      messages: [{ role: "user", content: "stream me" }],
      stream: true
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain("data:");
    expect(response.text).toContain("[DONE]");
  });

  it("exposes metrics endpoint with critical counters and latency histograms", async () => {
    const app = await createApp({ allowLegacyAuth: false });

    await request(app)
      .post("/chat")
      .set("Authorization", `Bearer ${FALLBACK_API_KEY}`)
      .send({
        model: "mock-default",
        stream: false,
        messages: [{ role: "user", content: "metrics please" }]
      });

    const metricsResponse = await request(app).get("/metrics");
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers["content-type"]).toContain("text/plain");
    expect(metricsResponse.text).toContain("tm_http_requests_total");
    expect(metricsResponse.text).toContain("tm_http_request_duration_ms_bucket");
    expect(metricsResponse.text).toContain("tm_chat_requests_total");
    expect(metricsResponse.text).toContain("tm_provider_call_duration_ms_bucket");
  });

  it("records audit events for auth failure, quota block and routing failure", async () => {
    const db = await createDatabase();
    const accessRepository = new AccessRepository(db);
    await accessRepository.createTenantProjectApiKey({
      tenantId: "tenant-audit",
      projectId: "project-audit",
      apiKey: "tm_quota_audit",
      tokenLimit: 1,
      costLimit: 1
    });
    const app = await createApp({ database: db, allowLegacyAuth: false });
    const auditRepository = new AuditRepository(db);

    await request(app)
      .post("/chat")
      .set("Authorization", "Bearer invalid-key")
      .send({
        model: "sim-local",
        stream: false,
        messages: [{ role: "user", content: "auth fail" }]
      });

    await request(app)
      .post("/chat")
      .set("Authorization", "Bearer tm_quota_audit")
      .send({
        model: "mock-default",
        stream: false,
        messages: [{ role: "user", content: "quota fail now" }]
      });

    await request(app)
      .post("/chat")
      .set("Authorization", `Bearer ${FALLBACK_API_KEY}`)
      .send({
        model: "not-routed-model",
        stream: false,
        messages: [{ role: "user", content: "route fail" }]
      });

    const events = await auditRepository.listRecent(20);
    expect(events.some((event) => event.eventType === "auth.failed")).toBe(true);
    expect(events.some((event) => event.eventType === "quota.blocked")).toBe(true);
    expect(events.some((event) => event.eventType === "routing.failed")).toBe(true);
  });
});
