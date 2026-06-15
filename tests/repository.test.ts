import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/client.js";
import type { UsageRecord } from "../src/metering/types.js";
import { UsageRepository } from "../src/repositories/usageRepository.js";

function ensurePostgresEnv(): void {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://admin:admin@127.0.0.1:5432/token_metering";
}

function buildRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    requestId: "req-1",
    tenantId: "tenant-1",
    projectId: "project-1",
    apiKeyId: "api-key-1",
    userId: "user-1",
    provider: "local-mock",
    model: "sim-local",
    tokenizerType: "tiktoken",
    promptTokensEstimated: 10,
    completionTokensEstimated: 5,
    promptTokensActual: 10,
    completionTokensActual: 5,
    totalTokensActual: 15,
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15
    },
    cost: {
      currency: "USD",
      inputCost: 0,
      outputCost: 0,
      totalCost: 0
    },
    latencyMs: 20,
    status: "success",
    createdAt: "2026-06-04T10:00:00.000Z",
    ...overrides
  };
}

describe("UsageRepository", () => {
  beforeEach(() => {
    process.env.DATABASE_CLIENT = "postgres";
    ensurePostgresEnv();
  });

  it("persists events and aggregates daily rollups", async () => {
    const db = await createDatabase();
    const repository = new UsageRepository(db);

    await repository.save(buildRecord());
    await repository.save(
      buildRecord({
        requestId: "req-2",
        completionTokensActual: 7,
        totalTokensActual: 17,
        usage: {
          promptTokens: 10,
          completionTokens: 7,
          totalTokens: 17
        }
      })
    );

    const summary = await repository.summary({ tenantId: "tenant-1", userId: "user-1" });
    expect(summary.count).toBe(2);
    expect(summary.promptTokens).toBe(20);
    expect(summary.completionTokens).toBe(12);
    expect(summary.totalTokens).toBe(32);

    const daily = await repository.daily({ tenantId: "tenant-1", userId: "user-1" });
    expect(daily).toHaveLength(1);
    expect(daily[0]?.totalTokens).toBe(32);

    const records = await repository.list({ tenantId: "tenant-1", userId: "user-1" });
    expect(records[0]?.tokenizerType).toBe("tiktoken");
  });

  it("enforces tenant scope on queries", async () => {
    const db = await createDatabase();
    const repository = new UsageRepository(db);

    await repository.save(
      buildRecord({
        requestId: "req-tenant-scope-1",
        tenantId: "tenant-scope-1",
        projectId: "project-scope-1",
        apiKeyId: "api-key-scope-1",
        userId: "user-scope-1"
      })
    );
    await repository.save(
      buildRecord({
        requestId: "req-tenant-2",
        tenantId: "tenant-scope-2",
        projectId: "project-scope-2",
        apiKeyId: "api-key-scope-2",
        userId: "user-scope-2"
      })
    );

    const tenant1Summary = await repository.summary({ tenantId: "tenant-scope-1" });
    const tenant2Summary = await repository.summary({ tenantId: "tenant-scope-2" });

    expect(tenant1Summary.count).toBe(1);
    expect(tenant2Summary.count).toBe(1);
  });
});
