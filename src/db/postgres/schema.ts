import { bigint, boolean, date, integer, jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  status: text("status").notNull(),
  scope: text("scope").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const projectQuotas = pgTable("project_quotas", {
  projectId: text("project_id").primaryKey(),
  tokenLimit: bigint("token_limit", { mode: "number" }).notNull(),
  tokenUsed: bigint("token_used", { mode: "number" }).notNull(),
  costLimit: numeric("cost_limit", { precision: 18, scale: 6 }).notNull(),
  costUsed: numeric("cost_used", { precision: 18, scale: 6 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const modelProviderRoutes = pgTable("model_provider_routes", {
  model: text("model").primaryKey(),
  providerId: text("provider_id").notNull(),
  providerModel: text("provider_model").notNull(),
  isActive: boolean("is_active").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const upstreamProviders = pgTable("upstream_providers", {
  providerId: text("provider_id").primaryKey(),
  providerType: text("provider_type").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  isActive: boolean("is_active").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const usageEvents = pgTable("usage_events", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  requestId: text("request_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  apiKeyId: text("api_key_id").notNull(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  tokenizerType: text("tokenizer_type").notNull(),
  promptTokensEstimated: bigint("prompt_tokens_estimated", { mode: "number" }).notNull(),
  completionTokensEstimated: bigint("completion_tokens_estimated", { mode: "number" }).notNull(),
  promptTokensActual: bigint("prompt_tokens_actual", { mode: "number" }).notNull(),
  completionTokensActual: bigint("completion_tokens_actual", { mode: "number" }).notNull(),
  totalTokensActual: bigint("total_tokens_actual", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  costInput: numeric("cost_input", { precision: 18, scale: 6 }).notNull(),
  costOutput: numeric("cost_output", { precision: 18, scale: 6 }).notNull(),
  costTotal: numeric("cost_total", { precision: 18, scale: 6 }).notNull(),
  latencyMs: integer("latency_ms").notNull(),
  status: text("status").notNull(),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const usageDailyRollups = pgTable("usage_daily_rollups", {
  date: date("date").notNull(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptTokens: bigint("prompt_tokens", { mode: "number" }).notNull(),
  completionTokens: bigint("completion_tokens", { mode: "number" }).notNull(),
  totalTokens: bigint("total_tokens", { mode: "number" }).notNull(),
  costTotal: numeric("cost_total", { precision: 18, scale: 6 }).notNull(),
  currency: text("currency").notNull()
});

export const auditEvents = pgTable("audit_events", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  eventType: text("event_type").notNull(),
  outcome: text("outcome").notNull(),
  requestId: text("request_id"),
  tenantId: text("tenant_id"),
  projectId: text("project_id"),
  apiKeyId: text("api_key_id"),
  provider: text("provider"),
  model: text("model"),
  method: text("method"),
  path: text("path"),
  errorCode: text("error_code"),
  message: text("message"),
  metadataJson: jsonb("metadata_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});
