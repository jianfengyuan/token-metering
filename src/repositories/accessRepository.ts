import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { apiKeys, modelRoutes, projectQuotas, projects, tenants } from "../db/postgres/schema.js";
import type { DatabaseClient } from "../db/types.js";

export interface AccessRepositoryOptions {
  defaultApiKey?: string;
  defaultTokenLimit?: number;
  defaultCostLimit?: number;
}

export interface AuthContext {
  tenantId: string;
  projectId: string;
  apiKeyId: string;
  userId: string;
  scopes: string[];
  authType: "api_key" | "legacy";
}

export interface ApiKeyIdentity {
  tenantId: string;
  projectId: string;
  apiKeyId: string;
  scopes: string[];
}

export interface ModelRoute {
  model: string;
  providerId: string;
  providerModel: string;
}

export interface TenantProjectApiKeySeed {
  tenantId: string;
  projectId: string;
  tenantName?: string;
  projectName?: string;
  apiKey?: string;
  scope?: string;
  tokenLimit?: number;
  costLimit?: number;
}

export interface SeedResult {
  tenantId: string;
  projectId: string;
  apiKeyId: string;
  apiKey: string;
}

export const DEFAULT_TENANT_ID = "tenant-default";
export const DEFAULT_PROJECT_ID = "project-default";
export const DEFAULT_API_KEY_ID = "api-key-default";
export const DEFAULT_LEGACY_USER_ID = "legacy-user";
export const FALLBACK_API_KEY = "tm_default_dev_key";

const DEFAULT_TOKEN_LIMIT = 1_000_000;
const DEFAULT_COST_LIMIT = 1_000;

function parseScopes(rawScope: string): string[] {
  return rawScope
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

function toIsoDate(): string {
  return new Date().toISOString();
}

export function hashApiKey(rawApiKey: string): string {
  return createHash("sha256").update(rawApiKey).digest("hex");
}

export class AccessRepository {
  private readonly pgOrm: NodePgDatabase;
  private readonly defaultApiKey: string;
  private readonly defaultTokenLimit: number;
  private readonly defaultCostLimit: number;
  private seedPromise: Promise<void> | null = null;

  constructor(db: DatabaseClient, options: AccessRepositoryOptions = {}) {
    if (!db.nativeClient) {
      throw new Error("PostgreSQL native client is required");
    }
    this.pgOrm = drizzle(db.nativeClient as Pool);
    this.defaultApiKey = options.defaultApiKey ?? process.env.DEFAULT_API_KEY ?? FALLBACK_API_KEY;
    this.defaultTokenLimit = options.defaultTokenLimit ?? Number(process.env.DEFAULT_PROJECT_TOKEN_LIMIT ?? DEFAULT_TOKEN_LIMIT);
    this.defaultCostLimit = options.defaultCostLimit ?? Number(process.env.DEFAULT_PROJECT_COST_LIMIT ?? DEFAULT_COST_LIMIT);
  }

  private async ensureSeeded(): Promise<void> {
    if (!this.seedPromise) {
      this.seedPromise = this.seedDefaults().catch((error) => {
        this.seedPromise = null;
        throw error;
      });
    }
    await this.seedPromise;
  }

  private async seedDefaults(): Promise<void> {
    const now = toIsoDate();
    const defaultScope = "chat.write,usage.read";
    const nowDate = new Date(now);
    await this.pgOrm
      .insert(tenants)
      .values({
        id: DEFAULT_TENANT_ID,
        name: "Default Tenant",
        status: "active",
        createdAt: nowDate
      })
      .onConflictDoNothing();
    await this.pgOrm
      .insert(projects)
      .values({
        id: DEFAULT_PROJECT_ID,
        tenantId: DEFAULT_TENANT_ID,
        name: "Default Project",
        status: "active",
        createdAt: nowDate
      })
      .onConflictDoNothing();
    await this.pgOrm
      .insert(apiKeys)
      .values({
        id: DEFAULT_API_KEY_ID,
        projectId: DEFAULT_PROJECT_ID,
        keyHash: hashApiKey(this.defaultApiKey),
        keyPrefix: this.defaultApiKey.slice(0, 8),
        status: "active",
        scope: defaultScope,
        createdAt: nowDate
      })
      .onConflictDoNothing();
    await this.pgOrm
      .insert(projectQuotas)
      .values({
        projectId: DEFAULT_PROJECT_ID,
        tokenLimit: this.defaultTokenLimit,
        tokenUsed: 0,
        costLimit: String(this.defaultCostLimit),
        costUsed: "0",
        updatedAt: nowDate
      })
      .onConflictDoNothing();
    await this.pgOrm
      .insert(modelRoutes)
      .values([
        {
          model: "sim-local",
          providerId: "local-simulator",
          providerModel: "sim-local",
          isActive: true,
          updatedAt: nowDate
        },
        {
          model: "llama3.2",
          providerId: "local-ollama",
          providerModel: "gemma4:e2b",
          isActive: true,
          updatedAt: nowDate
        },
        {
          model: "gpt-4o-mini",
          providerId: "local-simulator",
          providerModel: "sim-local",
          isActive: true,
          updatedAt: nowDate
        },
        {
          model: "mock-default",
          providerId: "local-mock",
          providerModel: "sim-local",
          isActive: true,
          updatedAt: nowDate
        }
      ])
      .onConflictDoNothing();
  }

  private isExpired(expiresAt: unknown): boolean {
    if (!expiresAt) {
      return false;
    }
    const parsed =
      expiresAt instanceof Date
        ? expiresAt.getTime()
        : typeof expiresAt === "string"
          ? Date.parse(expiresAt)
          : Number.NaN;
    if (!Number.isFinite(parsed)) {
      return false;
    }
    return parsed <= Date.now();
  }

  async resolveApiKey(rawApiKey: string): Promise<ApiKeyIdentity | null> {
    await this.ensureSeeded();
    if (!rawApiKey) {
      return null;
    }
    const keyHash = hashApiKey(rawApiKey);
    const rows = await this.pgOrm
      .select({
        api_key_id: apiKeys.id,
        scope: apiKeys.scope,
        api_key_status: apiKeys.status,
        expires_at: apiKeys.expiresAt,
        revoked_at: apiKeys.revokedAt,
        project_id: projects.id,
        project_status: projects.status,
        tenant_id: tenants.id,
        tenant_status: tenants.status
      })
      .from(apiKeys)
      .innerJoin(projects, eq(projects.id, apiKeys.projectId))
      .innerJoin(tenants, eq(tenants.id, projects.tenantId))
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);
    const row = rows[0];

    if (!row) {
      return null;
    }
    if (row.api_key_status !== "active" || row.project_status !== "active" || row.tenant_status !== "active") {
      return null;
    }
    if (row.revoked_at) {
      return null;
    }
    if (this.isExpired(row.expires_at)) {
      return null;
    }

    return {
      tenantId: row.tenant_id,
      projectId: row.project_id,
      apiKeyId: row.api_key_id,
      scopes: parseScopes(row.scope)
    };
  }

  getLegacyContext(userId?: string): AuthContext {
    return {
      tenantId: DEFAULT_TENANT_ID,
      projectId: DEFAULT_PROJECT_ID,
      apiKeyId: DEFAULT_API_KEY_ID,
      userId: userId && userId.trim().length > 0 ? userId.trim() : DEFAULT_LEGACY_USER_ID,
      scopes: ["*"],
      authType: "legacy"
    };
  }

  async listActiveModelRoutes(): Promise<ModelRoute[]> {
    await this.ensureSeeded();
    const rows = await this.pgOrm
      .select({
        model: modelRoutes.model,
        provider_id: modelRoutes.providerId,
        provider_model: modelRoutes.providerModel
      })
      .from(modelRoutes)
      .where(eq(modelRoutes.isActive, true));

    return rows.map((row) => ({
      model: row.model,
      providerId: row.provider_id,
      providerModel: row.provider_model
    }));
  }

  async createTenantProjectApiKey(seed: TenantProjectApiKeySeed): Promise<SeedResult> {
    await this.ensureSeeded();
    const now = toIsoDate();
    const nowDate = new Date(now);
    const apiKey = seed.apiKey ?? `tm_${randomUUID().replace(/-/g, "")}`;
    const apiKeyId = `api-key-${randomUUID()}`;
    const scope = seed.scope ?? "chat.write,usage.read";
    const tokenLimit = seed.tokenLimit ?? this.defaultTokenLimit;
    const costLimit = seed.costLimit ?? this.defaultCostLimit;

    await this.pgOrm.transaction(async (tx) => {
      await tx
        .insert(tenants)
        .values({
          id: seed.tenantId,
          name: seed.tenantName ?? seed.tenantId,
          status: "active",
          createdAt: nowDate
        })
        .onConflictDoNothing();
      await tx
        .insert(projects)
        .values({
          id: seed.projectId,
          tenantId: seed.tenantId,
          name: seed.projectName ?? seed.projectId,
          status: "active",
          createdAt: nowDate
        })
        .onConflictDoNothing();
      await tx.insert(apiKeys).values({
        id: apiKeyId,
        projectId: seed.projectId,
        keyHash: hashApiKey(apiKey),
        keyPrefix: apiKey.slice(0, 8),
        status: "active",
        scope,
        createdAt: nowDate
      });
      await tx
        .insert(projectQuotas)
        .values({
          projectId: seed.projectId,
          tokenLimit,
          tokenUsed: 0,
          costLimit: String(costLimit),
          costUsed: "0",
          updatedAt: nowDate
        })
        .onConflictDoNothing();
    });

    return {
      tenantId: seed.tenantId,
      projectId: seed.projectId,
      apiKeyId,
      apiKey
    };
  }
}
