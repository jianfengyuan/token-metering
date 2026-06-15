import { desc } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { auditEvents } from "../db/postgres/schema.js";
import type { DatabaseClient } from "../db/types.js";
import { metrics } from "../observability/metrics.js";
import { logger } from "../utils/logger.js";

export interface AuditEventInput {
  eventType: string;
  outcome: "success" | "failure" | "blocked";
  requestId?: string;
  tenantId?: string;
  projectId?: string;
  apiKeyId?: string;
  provider?: string;
  model?: string;
  method?: string;
  path?: string;
  errorCode?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface AuditEventRecord extends AuditEventInput {
  id: number;
  createdAt: string;
}

export class AuditRepository {
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

  private parseMetadata(value: unknown): Record<string, unknown> | undefined {
    if (!value) {
      return undefined;
    }
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
    if (typeof value === "object") {
      return value as Record<string, unknown>;
    }
    return undefined;
  }

  async save(event: AuditEventInput): Promise<AuditEventRecord> {
    const createdAt = event.createdAt ?? new Date().toISOString();
    const rows = await this.pgOrm
      .insert(auditEvents)
      .values({
        eventType: event.eventType,
        outcome: event.outcome,
        requestId: event.requestId ?? null,
        tenantId: event.tenantId ?? null,
        projectId: event.projectId ?? null,
        apiKeyId: event.apiKeyId ?? null,
        provider: event.provider ?? null,
        model: event.model ?? null,
        method: event.method ?? null,
        path: event.path ?? null,
        errorCode: event.errorCode ?? null,
        message: event.message ?? null,
        metadataJson: event.metadata ?? null,
        createdAt: new Date(createdAt)
      })
      .returning({ id: auditEvents.id });
    const row = rows[0];

    metrics.auditEventsTotal.inc({
      eventType: event.eventType,
      outcome: event.outcome
    });
    logger.warn("audit.event.recorded", {
      eventType: event.eventType,
      outcome: event.outcome,
      requestId: event.requestId,
      tenantId: event.tenantId,
      projectId: event.projectId,
      apiKeyId: event.apiKeyId,
      provider: event.provider,
      model: event.model,
      errorCode: event.errorCode
    });

    return {
      id: this.toNumber(row?.id),
      ...event,
      createdAt
    };
  }

  async listRecent(limit = 50): Promise<AuditEventRecord[]> {
    const rows = await this.pgOrm
      .select({
        id: auditEvents.id,
        event_type: auditEvents.eventType,
        outcome: auditEvents.outcome,
        request_id: auditEvents.requestId,
        tenant_id: auditEvents.tenantId,
        project_id: auditEvents.projectId,
        api_key_id: auditEvents.apiKeyId,
        provider: auditEvents.provider,
        model: auditEvents.model,
        method: auditEvents.method,
        path: auditEvents.path,
        error_code: auditEvents.errorCode,
        message: auditEvents.message,
        metadata_json: auditEvents.metadataJson,
        created_at: auditEvents.createdAt
      })
      .from(auditEvents)
      .orderBy(desc(auditEvents.id))
      .limit(limit);

    return rows.map((row) => ({
      id: this.toNumber(row.id),
      eventType: row.event_type,
      outcome: row.outcome as "success" | "failure" | "blocked",
      requestId: row.request_id ?? undefined,
      tenantId: row.tenant_id ?? undefined,
      projectId: row.project_id ?? undefined,
      apiKeyId: row.api_key_id ?? undefined,
      provider: row.provider ?? undefined,
      model: row.model ?? undefined,
      method: row.method ?? undefined,
      path: row.path ?? undefined,
      errorCode: row.error_code ?? undefined,
      message: row.message ?? undefined,
      metadata: this.parseMetadata(row.metadata_json),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
    }));
  }
}
