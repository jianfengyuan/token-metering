import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { usageDailyRollups, usageEvents } from "../db/postgres/schema.js";
import type { DatabaseClient } from "../db/types.js";
import type { UsageRecord } from "../metering/types.js";
import { logger } from "../utils/logger.js";

export interface UsageQuery {
  tenantId: string;
  projectId?: string;
  apiKeyId?: string;
  userId?: string;
  provider?: string;
  model?: string;
  from?: string;
  to?: string;
}

export interface DailyRollup {
  date: string;
  tenantId: string;
  projectId: string;
  userId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCost: number;
  currency: string;
}

export class UsageRepository {
  private readonly pgOrm: NodePgDatabase;

  constructor(db: DatabaseClient) {
    if (!db.nativeClient) {
      throw new Error("PostgreSQL native client is required");
    }
    this.pgOrm = drizzle(db.nativeClient as Pool);
  }

  private toNumber(value: unknown): number {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private toIsoDate(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return new Date().toISOString();
  }

  private toRollupDate(value: unknown): string {
    if (typeof value === "string") {
      return value.slice(0, 10);
    }
    if (value instanceof Date) {
      return value.toISOString().slice(0, 10);
    }
    return "";
  }

  async save(record: UsageRecord): Promise<UsageRecord> {
    await this.pgOrm.insert(usageEvents).values({
      requestId: record.requestId,
      tenantId: record.tenantId,
      projectId: record.projectId,
      apiKeyId: record.apiKeyId,
      userId: record.userId,
      provider: record.provider,
      model: record.model,
      tokenizerType: record.tokenizerType,
      promptTokensEstimated: record.promptTokensEstimated,
      completionTokensEstimated: record.completionTokensEstimated,
      promptTokensActual: record.promptTokensActual,
      completionTokensActual: record.completionTokensActual,
      totalTokensActual: record.totalTokensActual,
      currency: record.cost.currency,
      costInput: String(record.cost.inputCost),
      costOutput: String(record.cost.outputCost),
      costTotal: String(record.cost.totalCost),
      latencyMs: record.latencyMs,
      status: record.status,
      errorCode: record.errorCode ?? null,
      createdAt: new Date(record.createdAt)
    });
    if (record.status === "success") {
      const date = record.createdAt.slice(0, 10);
      await this.pgOrm
        .insert(usageDailyRollups)
        .values({
          date,
          tenantId: record.tenantId,
          projectId: record.projectId,
          userId: record.userId,
          provider: record.provider,
          model: record.model,
          promptTokens: record.promptTokensActual,
          completionTokens: record.completionTokensActual,
          totalTokens: record.totalTokensActual,
          costTotal: String(record.cost.totalCost),
          currency: record.cost.currency
        })
        .onConflictDoUpdate({
          target: [
            usageDailyRollups.date,
            usageDailyRollups.tenantId,
            usageDailyRollups.projectId,
            usageDailyRollups.userId,
            usageDailyRollups.provider,
            usageDailyRollups.model
          ],
          set: {
            promptTokens: sql`${usageDailyRollups.promptTokens} + ${record.promptTokensActual}`,
            completionTokens: sql`${usageDailyRollups.completionTokens} + ${record.completionTokensActual}`,
            totalTokens: sql`${usageDailyRollups.totalTokens} + ${record.totalTokensActual}`,
            costTotal: sql`${usageDailyRollups.costTotal} + ${record.cost.totalCost}`
          }
        });
    }

    logger.info("usage.repository.saved", {
      requestId: record.requestId,
      tenantId: record.tenantId,
      projectId: record.projectId,
      apiKeyId: record.apiKeyId,
      userId: record.userId,
      provider: record.provider,
      model: record.model,
      status: record.status,
      totalTokens: record.totalTokensActual,
      totalCost: record.cost.totalCost
    });

    return record;
  }

  async list(query: UsageQuery): Promise<UsageRecord[]> {
    const conditions = [eq(usageEvents.tenantId, query.tenantId)];
    if (query.projectId) {
      conditions.push(eq(usageEvents.projectId, query.projectId));
    }
    if (query.apiKeyId) {
      conditions.push(eq(usageEvents.apiKeyId, query.apiKeyId));
    }
    if (query.userId) {
      conditions.push(eq(usageEvents.userId, query.userId));
    }
    if (query.provider) {
      conditions.push(eq(usageEvents.provider, query.provider));
    }
    if (query.model) {
      conditions.push(eq(usageEvents.model, query.model));
    }
    if (query.from) {
      conditions.push(gte(usageEvents.createdAt, new Date(query.from)));
    }
    if (query.to) {
      conditions.push(lte(usageEvents.createdAt, new Date(query.to)));
    }
    const rows = await this.pgOrm
      .select({
        request_id: usageEvents.requestId,
        tenant_id: usageEvents.tenantId,
        project_id: usageEvents.projectId,
        api_key_id: usageEvents.apiKeyId,
        user_id: usageEvents.userId,
        provider: usageEvents.provider,
        model: usageEvents.model,
        tokenizer_type: usageEvents.tokenizerType,
        prompt_tokens_estimated: usageEvents.promptTokensEstimated,
        completion_tokens_estimated: usageEvents.completionTokensEstimated,
        prompt_tokens_actual: usageEvents.promptTokensActual,
        completion_tokens_actual: usageEvents.completionTokensActual,
        total_tokens_actual: usageEvents.totalTokensActual,
        currency: usageEvents.currency,
        cost_input: usageEvents.costInput,
        cost_output: usageEvents.costOutput,
        cost_total: usageEvents.costTotal,
        latency_ms: usageEvents.latencyMs,
        status: usageEvents.status,
        error_code: usageEvents.errorCode,
        created_at: usageEvents.createdAt
      })
      .from(usageEvents)
      .where(and(...conditions))
      .orderBy(desc(usageEvents.createdAt));

    return rows.map((row) => ({
      requestId: row.request_id,
      tenantId: row.tenant_id,
      projectId: row.project_id,
      apiKeyId: row.api_key_id,
      userId: row.user_id,
      provider: row.provider,
      model: row.model,
      tokenizerType: row.tokenizer_type as UsageRecord["tokenizerType"],
      promptTokensEstimated: this.toNumber(row.prompt_tokens_estimated),
      completionTokensEstimated: this.toNumber(row.completion_tokens_estimated),
      promptTokensActual: this.toNumber(row.prompt_tokens_actual),
      completionTokensActual: this.toNumber(row.completion_tokens_actual),
      totalTokensActual: this.toNumber(row.total_tokens_actual),
      usage: {
        promptTokens: this.toNumber(row.prompt_tokens_actual),
        completionTokens: this.toNumber(row.completion_tokens_actual),
        totalTokens: this.toNumber(row.total_tokens_actual)
      },
      cost: {
        currency: row.currency,
        inputCost: this.toNumber(row.cost_input),
        outputCost: this.toNumber(row.cost_output),
        totalCost: this.toNumber(row.cost_total)
      },
      latencyMs: this.toNumber(row.latency_ms),
      status: row.status as UsageRecord["status"],
      errorCode: row.error_code ?? undefined,
      createdAt: this.toIsoDate(row.created_at)
    }));
  }

  async summary(query: UsageQuery): Promise<{
    count: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    totalCost: number;
    currency: string;
  }> {
    const conditions = [eq(usageEvents.tenantId, query.tenantId)];
    if (query.projectId) {
      conditions.push(eq(usageEvents.projectId, query.projectId));
    }
    if (query.apiKeyId) {
      conditions.push(eq(usageEvents.apiKeyId, query.apiKeyId));
    }
    if (query.userId) {
      conditions.push(eq(usageEvents.userId, query.userId));
    }
    if (query.provider) {
      conditions.push(eq(usageEvents.provider, query.provider));
    }
    if (query.model) {
      conditions.push(eq(usageEvents.model, query.model));
    }
    if (query.from) {
      conditions.push(gte(usageEvents.createdAt, new Date(query.from)));
    }
    if (query.to) {
      conditions.push(lte(usageEvents.createdAt, new Date(query.to)));
    }

    const rows = await this.pgOrm
      .select({
        count: sql<number>`COUNT(*)`,
        prompt_tokens: sql<number>`COALESCE(SUM(${usageEvents.promptTokensActual}), 0)`,
        completion_tokens: sql<number>`COALESCE(SUM(${usageEvents.completionTokensActual}), 0)`,
        total_tokens: sql<number>`COALESCE(SUM(${usageEvents.totalTokensActual}), 0)`,
        total_cost: sql<number>`COALESCE(SUM(${usageEvents.costTotal}), 0)`,
        currency: sql<string>`COALESCE(MAX(${usageEvents.currency}), 'USD')`
      })
      .from(usageEvents)
      .where(and(...conditions));
    const row = rows[0];

    if (!row) {
      return {
        count: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        currency: "USD"
      };
    }

    return {
      count: this.toNumber(row.count),
      promptTokens: this.toNumber(row.prompt_tokens),
      completionTokens: this.toNumber(row.completion_tokens),
      totalTokens: this.toNumber(row.total_tokens),
      totalCost: this.toNumber(row.total_cost),
      currency: row.currency
    };
  }

  async daily(query: UsageQuery): Promise<DailyRollup[]> {
    const conditions = [eq(usageDailyRollups.tenantId, query.tenantId)];
    if (query.projectId) {
      conditions.push(eq(usageDailyRollups.projectId, query.projectId));
    }
    if (query.userId) {
      conditions.push(eq(usageDailyRollups.userId, query.userId));
    }
    if (query.provider) {
      conditions.push(eq(usageDailyRollups.provider, query.provider));
    }
    if (query.model) {
      conditions.push(eq(usageDailyRollups.model, query.model));
    }
    if (query.from) {
      conditions.push(gte(usageDailyRollups.date, query.from.slice(0, 10)));
    }
    if (query.to) {
      conditions.push(lte(usageDailyRollups.date, query.to.slice(0, 10)));
    }

    const rows = await this.pgOrm
      .select({
        date: usageDailyRollups.date,
        tenant_id: usageDailyRollups.tenantId,
        project_id: usageDailyRollups.projectId,
        user_id: usageDailyRollups.userId,
        provider: usageDailyRollups.provider,
        model: usageDailyRollups.model,
        prompt_tokens: usageDailyRollups.promptTokens,
        completion_tokens: usageDailyRollups.completionTokens,
        total_tokens: usageDailyRollups.totalTokens,
        cost_total: usageDailyRollups.costTotal,
        currency: usageDailyRollups.currency
      })
      .from(usageDailyRollups)
      .where(and(...conditions))
      .orderBy(desc(usageDailyRollups.date));

    return rows.map((row) => ({
      date: this.toRollupDate(row.date),
      tenantId: row.tenant_id,
      projectId: row.project_id,
      userId: row.user_id,
      provider: row.provider,
      model: row.model,
      promptTokens: this.toNumber(row.prompt_tokens),
      completionTokens: this.toNumber(row.completion_tokens),
      totalTokens: this.toNumber(row.total_tokens),
      totalCost: this.toNumber(row.cost_total),
      currency: row.currency
    }));
  }
}
