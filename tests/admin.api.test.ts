import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { metrics } from "../src/observability/metrics.js";
import { AccessRepository } from "../src/repositories/accessRepository.js";

const ADMIN_TOKEN = "test-admin-token";

function ensurePostgresEnv(): void {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://admin:admin@127.0.0.1:5432/token_metering";
}

async function createTestApp() {
  const database = await createDatabase();
  const accessRepository = new AccessRepository(database);
  await accessRepository.upsertProviderConfig({
    providerId: "local-simulator",
    providerType: "openai_compatible",
    baseUrl: "http://127.0.0.1:3000/simulator/v1",
    apiKey: "local-dev"
  });
  await accessRepository.upsertProviderConfig({
    providerId: "local-mock",
    providerType: "mock_local",
    baseUrl: "mock://local",
    apiKey: "mock-local"
  });
  await accessRepository.upsertModelRoute({
    model: "sim-local",
    providerId: "local-simulator",
    providerModel: "sim-local"
  });
  await accessRepository.upsertModelRoute({
    model: "mock-default",
    providerId: "local-mock",
    providerModel: "sim-local"
  });
  return createApp({
    database,
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

  it("provisions tenant, project and api key usable for chat", async () => {
    const app = await createTestApp();
    const createResponse = await request(app)
      .post("/admin/v1/tenants/provision")
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

  it("returns 409 when provisioning duplicate project", async () => {
    const app = await createTestApp();
    await request(app)
      .post("/admin/v1/tenants/provision")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ tenantId: "tenant-dup", projectId: "project-dup" });

    const response = await request(app)
      .post("/admin/v1/tenants/provision")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ tenantId: "tenant-dup-2", projectId: "project-dup" });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("CONFLICT");
  });

  it("creates project with initial api key under existing tenant", async () => {
    const app = await createTestApp();
    await request(app)
      .post("/admin/v1/tenants")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ tenantId: "tenant-project-only", tenantName: "Project Only Tenant" });

    const response = await request(app)
      .post("/admin/v1/tenants/tenant-project-only/projects")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ projectId: "project-child", projectName: "Child Project" });

    expect(response.status).toBe(201);
    expect(response.body.apiKey).toMatch(/^tm_/);
    expect(response.body.projectId).toBe("project-child");
  });

  it("lists, revokes and rotates api keys", async () => {
    const app = await createTestApp();
    const provision = await request(app)
      .post("/admin/v1/tenants/provision")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ tenantId: "tenant-keys", projectId: "project-keys" });

    const apiKey = provision.body.apiKey;
    const apiKeyId = provision.body.apiKeyId;

    const listResponse = await request(app)
      .get("/admin/v1/projects/project-keys/api-keys")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.apiKeys).toHaveLength(1);
    expect(listResponse.body.apiKeys[0].keyPrefix).toBe(apiKey.slice(0, 8));

    await request(app)
      .post("/chat")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({
        model: "mock-default",
        stream: false,
        messages: [{ role: "user", content: "touch last_used" }]
      });

    const listAfterUse = await request(app)
      .get("/admin/v1/projects/project-keys/api-keys")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(listAfterUse.body.apiKeys[0].lastUsedAt).toBeTruthy();

    const revokeResponse = await request(app)
      .post(`/admin/v1/api-keys/${apiKeyId}/revoke`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(revokeResponse.status).toBe(200);
    expect(revokeResponse.body.apiKey.status).toBe("revoked");

    const chatAfterRevoke = await request(app)
      .post("/chat")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({
        model: "mock-default",
        stream: false,
        messages: [{ role: "user", content: "should fail" }]
      });
    expect(chatAfterRevoke.status).toBe(401);

    const rotateResponse = await request(app)
      .post(`/admin/v1/api-keys/${apiKeyId}/rotate`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(rotateResponse.status).toBe(201);
    expect(rotateResponse.body.apiKey).toMatch(/^tm_/);

    const chatWithNewKey = await request(app)
      .post("/chat")
      .set("Authorization", `Bearer ${rotateResponse.body.apiKey}`)
      .send({
        model: "mock-default",
        stream: false,
        messages: [{ role: "user", content: "rotated key works" }]
      });
    expect(chatWithNewKey.status).toBe(200);
  });

  it("manages users and tenant members", async () => {
    const app = await createTestApp();
    await request(app)
      .post("/admin/v1/tenants/provision")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ tenantId: "tenant-members", projectId: "project-members" });

    const userResponse = await request(app)
      .post("/admin/v1/users")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ email: "member@example.com", name: "Member User", platformRole: "platform_admin" });
    expect(userResponse.status).toBe(201);
    const userId = userResponse.body.user.id;

    const memberResponse = await request(app)
      .post("/admin/v1/tenants/tenant-members/members")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ userId, role: "admin" });
    expect(memberResponse.status).toBe(201);
    expect(memberResponse.body.member.role).toBe("admin");

    const listMembers = await request(app)
      .get("/admin/v1/tenants/tenant-members/members")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(listMembers.body.members).toHaveLength(1);
    expect(listMembers.body.members[0].email).toBe("member@example.com");
  });

  it("validates tenant creation payload", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/admin/v1/tenants/provision")
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

  it("allows admin to add model routes and use them immediately", async () => {
    const app = await createTestApp();
    const createRoute = await request(app)
      .post("/admin/v1/model-routes")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        model: "admin-added-model",
        providerId: "local-mock",
        providerModel: "sim-local"
      });

    expect(createRoute.status).toBe(201);
    expect(createRoute.body.modelRoute.model).toBe("admin-added-model");

    const routeList = await request(app)
      .get("/admin/v1/model-routes")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    const models = routeList.body.modelRoutes.map((route: { model: string }) => route.model);
    expect(models).toContain("admin-added-model");

    const chatResponse = await request(app)
      .post("/chat")
      .set("Authorization", "Bearer tm_default_dev_key")
      .send({
        model: "admin-added-model",
        stream: false,
        messages: [{ role: "user", content: "route from admin should work now" }]
      });
    expect(chatResponse.status).toBe(200);
    expect(chatResponse.body.usage.totalTokens).toBeGreaterThan(0);
  });

  it("rejects model routes with unsupported providers", async () => {
    const app = await createTestApp();
    const response = await request(app)
      .post("/admin/v1/model-routes")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        model: "admin-unsupported-provider",
        providerId: "provider-not-exist",
        providerModel: "sim-local"
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("UNSUPPORTED_PROVIDER");
  });

  it("allows admin to configure providers in database", async () => {
    const app = await createTestApp();
    const upsertResponse = await request(app)
      .post("/admin/v1/providers")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        providerId: "openai",
        providerType: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test-configured-by-admin"
      });
    expect(upsertResponse.status).toBe(201);
    expect(upsertResponse.body.provider.providerId).toBe("openai");
    expect(upsertResponse.body.provider.apiKeyMasked).toContain("...");

    const listResponse = await request(app)
      .get("/admin/v1/providers")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.providers.some((provider: { providerId: string }) => provider.providerId === "openai")).toBe(
      true
    );
  });

  it("accepts model routes for providers configured in database", async () => {
    const app = await createTestApp();
    await request(app)
      .post("/admin/v1/providers")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        providerId: "deepseek",
        providerType: "openai_compatible",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "deepseek-test-key"
      });

    const response = await request(app)
      .post("/admin/v1/model-routes")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        model: "deepseek-chat",
        providerId: "deepseek",
        providerModel: "deepseek-chat"
      });

    expect(response.status).toBe(201);
    expect(response.body.modelRoute.providerId).toBe("deepseek");
  });

  it("lists recent audit events including admin actions", async () => {
    const app = await createTestApp();
    await request(app)
      .post("/admin/v1/tenants/provision")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ tenantId: "tenant-audit-admin", projectId: "project-audit-admin" });
    await request(app).get("/admin/v1/usage").set("Authorization", "Bearer wrong-token");

    const response = await request(app)
      .get("/admin/v1/audit-events")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(response.status).toBe(200);
    const eventTypes = response.body.events.map((event: { eventType: string }) => event.eventType);
    expect(eventTypes).toContain("admin.tenant.provisioned");
    expect(eventTypes).toContain("admin.auth.failed");
  });

  it("returns usage summary and records for a tenant", async () => {
    const app = await createTestApp();
    const createResponse = await request(app)
      .post("/admin/v1/tenants/provision")
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
