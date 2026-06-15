import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { metrics } from "../src/observability/metrics.js";

const ADMIN_TOKEN = "test-admin-token";

function ensurePostgresEnv(): void {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://admin:admin@127.0.0.1:5432/token_metering";
}

async function createTestApp() {
  return createApp({
    database: await createDatabase(),
    allowLegacyAuth: false,
    adminToken: ADMIN_TOKEN
  });
}

describe("Admin API", () => {
  beforeEach(() => {
    process.env.DATABASE_CLIENT = "postgres";
    ensurePostgresEnv();
    metrics.resetForTests();
  });

  it("rejects admin requests without a token", async () => {
    const app = await createTestApp();
    const response = await request(app).get("/admin/v1/model-routes");

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("MISSING_ADMIN_TOKEN");
  });

  it("rejects admin requests with an invalid token", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .get("/admin/v1/audit-events")
      .set("Authorization", "Bearer wrong-token");

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("INVALID_ADMIN_TOKEN");
  });

  it("creates tenant, project and api key usable for chat", async () => {
    const app = await createTestApp();
    const createResponse = await request(app)
      .post("/admin/v1/tenants")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        tenantId: "tenant-admin-test",
        projectId: "project-admin-test",
        tenantName: "Admin Test Tenant"
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.tenantId).toBe("tenant-admin-test");
    expect(createResponse.body.projectId).toBe("project-admin-test");
    expect(createResponse.body.apiKey).toMatch(/^tm_/);

    const chatResponse = await request(app)
      .post("/chat")
      .set("Authorization", `Bearer ${createResponse.body.apiKey}`)
      .send({
        model: "mock-default",
        stream: false,
        messages: [{ role: "user", content: "hello from admin-created key" }]
      });

    expect(chatResponse.status).toBe(200);
    expect(chatResponse.body.usage.totalTokens).toBeGreaterThan(0);
  });

  it("validates tenant creation payload", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/admin/v1/tenants")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ tenantId: "tenant-only" });

    expect(response.status).toBe(400);
  });

  it("lists active model routes", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .get("/admin/v1/model-routes")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(response.status).toBe(200);
    const models = response.body.modelRoutes.map((route: { model: string }) => route.model);
    expect(models).toContain("mock-default");
    expect(models).toContain("sim-local");
  });

  it("lists recent audit events including admin actions", async () => {
    const app = await createTestApp();
    await request(app)
      .post("/admin/v1/tenants")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ tenantId: "tenant-audit-admin", projectId: "project-audit-admin" });
    await request(app).get("/admin/v1/usage").set("Authorization", "Bearer wrong-token");

    const response = await request(app)
      .get("/admin/v1/audit-events")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(response.status).toBe(200);
    const eventTypes = response.body.events.map((event: { eventType: string }) => event.eventType);
    expect(eventTypes).toContain("admin.tenant.created");
    expect(eventTypes).toContain("admin.auth.failed");
  });

  it("returns usage summary and records for a tenant", async () => {
    const app = await createTestApp();
    const createResponse = await request(app)
      .post("/admin/v1/tenants")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ tenantId: "tenant-usage-admin", projectId: "project-usage-admin" });

    await request(app)
      .post("/chat")
      .set("Authorization", `Bearer ${createResponse.body.apiKey}`)
      .send({
        model: "mock-default",
        stream: false,
        messages: [{ role: "user", content: "generate some usage" }]
      });

    const response = await request(app)
      .get("/admin/v1/usage")
      .query({ tenantId: "tenant-usage-admin" })
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.summary.count).toBe(1);
    expect(response.body.summary.totalTokens).toBeGreaterThan(0);
    expect(response.body.records).toHaveLength(1);
    expect(response.body.records[0].tenantId).toBe("tenant-usage-admin");
  });

  it("exposes public model list for the console", async () => {
    const app = await createTestApp();
    const response = await request(app).get("/models");

    expect(response.status).toBe(200);
    expect(response.body.models).toContain("mock-default");
  });
});
