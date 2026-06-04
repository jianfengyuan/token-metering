import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/client.js";
import type { UsageRecord } from "../src/metering/types.js";
import { UsageRepository } from "../src/repositories/usageRepository.js";

function buildRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    requestId: "req-1",
    userId: "user-1",
    provider: "local-mock",
    model: "sim-local",
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
  it("persists events and aggregates daily rollups", () => {
    const db = createDatabase(":memory:");
    const schemaPath = path.resolve(process.cwd(), "src/db/schema.sql");
    const repository = new UsageRepository(db, schemaPath);

    repository.save(buildRecord());
    repository.save(
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

    const summary = repository.summary({ userId: "user-1" });
    expect(summary.count).toBe(2);
    expect(summary.promptTokens).toBe(20);
    expect(summary.completionTokens).toBe(12);
    expect(summary.totalTokens).toBe(32);

    const daily = repository.daily({ userId: "user-1" });
    expect(daily).toHaveLength(1);
    expect(daily[0]?.totalTokens).toBe(32);
  });
});
