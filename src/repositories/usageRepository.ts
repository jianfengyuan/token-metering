import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { UsageRecord } from "../metering/types.js";
import { logger } from "../utils/logger.js";

export interface UsageQuery {
  userId?: string;
  provider?: string;
  model?: string;
  from?: string;
  to?: string;
}

export interface DailyRollup {
  date: string;
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
  private readonly db: Database.Database;

  constructor(db: Database.Database, schemaPath?: string) {
    this.db = db;
    const sqlPath = schemaPath ?? path.resolve(process.cwd(), "src", "db", "schema.sql");
    const schemaSql = fs.readFileSync(sqlPath, "utf8");
    this.db.exec(schemaSql);
    this.ensureUsageEventsColumns();
  }

  private ensureUsageEventsColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("tokenizer_type")) {
      this.db.exec("ALTER TABLE usage_events ADD COLUMN tokenizer_type TEXT NOT NULL DEFAULT 'tiktoken'");
    }
  }

  save(record: UsageRecord): UsageRecord {
    const insert = this.db.prepare(`
      INSERT INTO usage_events (
        request_id, user_id, provider, model,
        tokenizer_type,
        prompt_tokens_estimated, completion_tokens_estimated,
        prompt_tokens_actual, completion_tokens_actual, total_tokens_actual,
        currency, cost_input, cost_output, cost_total,
        latency_ms, status, error_code, created_at
      ) VALUES (
        @requestId, @userId, @provider, @model,
        @tokenizerType,
        @promptTokensEstimated, @completionTokensEstimated,
        @promptTokensActual, @completionTokensActual, @totalTokensActual,
        @currency, @costInput, @costOutput, @costTotal,
        @latencyMs, @status, @errorCode, @createdAt
      )
    `);

    insert.run({
      requestId: record.requestId,
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
      costInput: record.cost.inputCost,
      costOutput: record.cost.outputCost,
      costTotal: record.cost.totalCost,
      latencyMs: record.latencyMs,
      status: record.status,
      errorCode: record.errorCode ?? null,
      createdAt: record.createdAt
    });

    if (record.status === "success") {
      const date = record.createdAt.slice(0, 10);
      const upsertRollup = this.db.prepare(`
        INSERT INTO usage_daily_rollups (
          date, user_id, provider, model,
          prompt_tokens, completion_tokens, total_tokens,
          cost_total, currency
        ) VALUES (
          @date, @userId, @provider, @model,
          @promptTokens, @completionTokens, @totalTokens,
          @costTotal, @currency
        )
        ON CONFLICT(date, user_id, provider, model) DO UPDATE SET
          prompt_tokens = prompt_tokens + excluded.prompt_tokens,
          completion_tokens = completion_tokens + excluded.completion_tokens,
          total_tokens = total_tokens + excluded.total_tokens,
          cost_total = cost_total + excluded.cost_total
      `);

      upsertRollup.run({
        date,
        userId: record.userId,
        provider: record.provider,
        model: record.model,
        promptTokens: record.promptTokensActual,
        completionTokens: record.completionTokensActual,
        totalTokens: record.totalTokensActual,
        costTotal: record.cost.totalCost,
        currency: record.cost.currency
      });
    }

    logger.info("usage.repository.saved", {
      requestId: record.requestId,
      userId: record.userId,
      provider: record.provider,
      model: record.model,
      status: record.status,
      totalTokens: record.totalTokensActual,
      totalCost: record.cost.totalCost
    });

    return record;
  }

  private buildWhereClause(query: UsageQuery): { clause: string; params: Record<string, string> } {
    const conditions: string[] = [];
    const params: Record<string, string> = {};

    if (query.userId) {
      conditions.push("user_id = @userId");
      params.userId = query.userId;
    }
    if (query.provider) {
      conditions.push("provider = @provider");
      params.provider = query.provider;
    }
    if (query.model) {
      conditions.push("model = @model");
      params.model = query.model;
    }
    if (query.from) {
      conditions.push("created_at >= @from");
      params.from = query.from;
    }
    if (query.to) {
      conditions.push("created_at <= @to");
      params.to = query.to;
    }

    return {
      clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
      params
    };
  }

  list(query: UsageQuery = {}): UsageRecord[] {
    const { clause, params } = this.buildWhereClause(query);
    const rows = this.db
      .prepare(
        `
        SELECT
          request_id, user_id, provider, model,
          tokenizer_type,
          prompt_tokens_estimated, completion_tokens_estimated,
          prompt_tokens_actual, completion_tokens_actual, total_tokens_actual,
          currency, cost_input, cost_output, cost_total,
          latency_ms, status, error_code, created_at
        FROM usage_events
        ${clause}
        ORDER BY created_at DESC
      `
      )
      .all(params) as Array<{
      request_id: string;
      user_id: string;
      provider: string;
      model: string;
      tokenizer_type: UsageRecord["tokenizerType"];
      prompt_tokens_estimated: number;
      completion_tokens_estimated: number;
      prompt_tokens_actual: number;
      completion_tokens_actual: number;
      total_tokens_actual: number;
      currency: string;
      cost_input: number;
      cost_output: number;
      cost_total: number;
      latency_ms: number;
      status: "success" | "failed";
      error_code: string | null;
      created_at: string;
    }>;

    return rows.map((row) => ({
      requestId: row.request_id,
      userId: row.user_id,
      provider: row.provider,
      model: row.model,
      tokenizerType: row.tokenizer_type,
      promptTokensEstimated: row.prompt_tokens_estimated,
      completionTokensEstimated: row.completion_tokens_estimated,
      promptTokensActual: row.prompt_tokens_actual,
      completionTokensActual: row.completion_tokens_actual,
      totalTokensActual: row.total_tokens_actual,
      usage: {
        promptTokens: row.prompt_tokens_actual,
        completionTokens: row.completion_tokens_actual,
        totalTokens: row.total_tokens_actual
      },
      cost: {
        currency: row.currency,
        inputCost: row.cost_input,
        outputCost: row.cost_output,
        totalCost: row.cost_total
      },
      latencyMs: row.latency_ms,
      status: row.status,
      errorCode: row.error_code ?? undefined,
      createdAt: row.created_at
    }));
  }

  summary(query: UsageQuery = {}): {
    count: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    totalCost: number;
    currency: string;
  } {
    const { clause, params } = this.buildWhereClause(query);
    const row = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS count,
          COALESCE(SUM(prompt_tokens_actual), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens_actual), 0) AS completion_tokens,
          COALESCE(SUM(total_tokens_actual), 0) AS total_tokens,
          COALESCE(SUM(cost_total), 0) AS total_cost,
          COALESCE(MAX(currency), 'USD') AS currency
        FROM usage_events
        ${clause}
      `
      )
      .get(params) as {
      count: number;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      total_cost: number;
      currency: string;
    };

    return {
      count: row.count,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      totalCost: row.total_cost,
      currency: row.currency
    };
  }

  daily(query: UsageQuery = {}): DailyRollup[] {
    const conditions: string[] = [];
    const params: Record<string, string> = {};

    if (query.userId) {
      conditions.push("user_id = @userId");
      params.userId = query.userId;
    }
    if (query.provider) {
      conditions.push("provider = @provider");
      params.provider = query.provider;
    }
    if (query.model) {
      conditions.push("model = @model");
      params.model = query.model;
    }
    if (query.from) {
      conditions.push("date >= @fromDate");
      params.fromDate = query.from.slice(0, 10);
    }
    if (query.to) {
      conditions.push("date <= @toDate");
      params.toDate = query.to.slice(0, 10);
    }

    const clause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
        SELECT
          date, user_id, provider, model,
          prompt_tokens, completion_tokens, total_tokens,
          cost_total, currency
        FROM usage_daily_rollups
        ${clause}
        ORDER BY date DESC
      `
      )
      .all(params) as Array<{
      date: string;
      user_id: string;
      provider: string;
      model: string;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cost_total: number;
      currency: string;
    }>;

    return rows.map((row) => ({
      date: row.date,
      userId: row.user_id,
      provider: row.provider,
      model: row.model,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      totalCost: row.cost_total,
      currency: row.currency
    }));
  }
}
