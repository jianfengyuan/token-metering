import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { apiKeys, modelProviderRoutes, projectQuotas, projects, tenants, upstreamProviders } from "../db/postgres/schema.js";
import type { DatabaseClient } from "../db/types.js";

export class ConflictError extends Error {
  readonly code = "CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";

  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

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

export interface ModelRouteUpsertInput {
  model: string;
  providerId: string;
  providerModel: string;
}

export interface ProviderConfig {
  providerId: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
}

export interface ProviderConfigUpsertInput {
  providerId: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
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
  createdBy?: string;
}

export interface CreateTenantInput {
  tenantId: string;
  tenantName?: string;
}

export interface CreateProjectInput {
  tenantId: string;
  projectId: string;
  projectName?: string;
  tokenLimit?: number;
  costLimit?: number;
  scope?: string;
  createdBy?: string;
}

export interface CreateApiKeyInput {
  projectId: string;
  scope?: string;
  createdBy?: string;
}

export interface ApiKeyListItem {
  id: string;
  projectId: string;
  keyPrefix: string;
  status: string;
  scope: string;
  createdBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
}

export interface SeedResult {
  tenantId: string;
  projectId: string;
  apiKeyId: string;
  apiKey: string;
}

export interface TenantRecord {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface ProjectRecord {
  id: string;
  tenantId: string;
  name: string;
  status: string;
  createdAt: string;
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

function toIsoDate(value?: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function generateApiKeyRaw(): string {
  return `tm_${randomUUID().replace(/-/g, "")}`;
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
    const now = new Date();
    const defaultScope = "chat.write,usage.read";
    await this.pgOrm
      .insert(tenants)
      .values({
        id: DEFAULT_TENANT_ID,
        name: "Default Tenant",
        status: "active",
        createdAt: now
      })
      .onConflictDoNothing();
    await this.pgOrm
      .insert(projects)
      .values({
        id: DEFAULT_PROJECT_ID,
        tenantId: DEFAULT_TENANT_ID,
        name: "Default Project",
        status: "active",
        createdAt: now
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
        createdAt: now
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
        updatedAt: now
      })
      .onConflictDoNothing();
  }

  private async tenantExists(tenantId: string): Promise<boolean> {
    const rows = await this.pgOrm.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return rows.length > 0;
  }

  private async projectExists(projectId: string): Promise<boolean> {
    const rows = await this.pgOrm.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
    return rows.length > 0;
  }

  private async getProject(projectId: string): Promise<ProjectRecord | null> {
    const rows = await this.pgOrm
      .select({
        id: projects.id,
        tenant_id: projects.tenantId,
        name: projects.name,
        status: projects.status,
        created_at: projects.createdAt
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      status: row.status,
      createdAt: toIsoDate(row.created_at) ?? ""
    };
  }

  private mapApiKeyListItem(row: {
    id: string;
    project_id: string;
    key_prefix: string;
    status: string;
    scope: string;
    created_by: string | null;
    expires_at: Date | string | null;
    revoked_at: Date | string | null;
    last_used_at: Date | string | null;
    last_used_ip: string | null;
    created_at: Date | string;
  }): ApiKeyListItem {
    return {
      id: row.id,
      projectId: row.project_id,
      keyPrefix: row.key_prefix,
      status: row.status,
      scope: row.scope,
      createdBy: row.created_by,
      expiresAt: toIsoDate(row.expires_at),
      revokedAt: toIsoDate(row.revoked_at),
      lastUsedAt: toIsoDate(row.last_used_at),
      lastUsedIp: row.last_used_ip,
      createdAt: toIsoDate(row.created_at) ?? ""
    };
  }

  private async insertApiKeyRecord(
    projectId: string,
    scope: string,
    createdBy?: string,
    rawApiKey?: string
  ): Promise<{ apiKeyId: string; apiKey: string }> {
    const apiKey = rawApiKey ?? generateApiKeyRaw();
    const apiKeyId = `api-key-${randomUUID()}`;
    const now = new Date();
    await this.pgOrm.insert(apiKeys).values({
      id: apiKeyId,
      projectId,
      keyHash: hashApiKey(apiKey),
      keyPrefix: apiKey.slice(0, 8),
      status: "active",
      scope,
      createdBy: createdBy ?? null,
      createdAt: now
    });
    return { apiKeyId, apiKey };
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
        model: modelProviderRoutes.model,
        provider_id: modelProviderRoutes.providerId,
        provider_model: modelProviderRoutes.providerModel
      })
      .from(modelProviderRoutes)
      .where(eq(modelProviderRoutes.isActive, true));

    return rows.map((row) => ({
      model: row.model,
      providerId: row.provider_id,
      providerModel: row.provider_model
    }));
  }

  async upsertModelRoute(input: ModelRouteUpsertInput): Promise<ModelRoute> {
    await this.ensureSeeded();
    const now = new Date();
    await this.pgOrm
      .insert(modelProviderRoutes)
      .values({
        model: input.model,
        providerId: input.providerId,
        providerModel: input.providerModel,
        isActive: true,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: modelProviderRoutes.model,
        set: {
          providerId: input.providerId,
          providerModel: input.providerModel,
          isActive: true,
          updatedAt: now
        }
      });

    return {
      model: input.model,
      providerId: input.providerId,
      providerModel: input.providerModel
    };
  }

  async listActiveProviderConfigs(): Promise<ProviderConfig[]> {
    await this.ensureSeeded();
    const rows = await this.pgOrm
      .select({
        provider_id: upstreamProviders.providerId,
        provider_type: upstreamProviders.providerType,
        base_url: upstreamProviders.baseUrl,
        api_key: upstreamProviders.apiKey
      })
      .from(upstreamProviders)
      .where(eq(upstreamProviders.isActive, true));

    return rows.map((row) => ({
      providerId: row.provider_id,
      providerType: row.provider_type,
      baseUrl: row.base_url,
      apiKey: row.api_key
    }));
  }

  async upsertProviderConfig(input: ProviderConfigUpsertInput): Promise<ProviderConfig> {
    await this.ensureSeeded();
    const now = new Date();
    await this.pgOrm
      .insert(upstreamProviders)
      .values({
        providerId: input.providerId,
        providerType: input.providerType,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        isActive: true,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: upstreamProviders.providerId,
        set: {
          providerType: input.providerType,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          isActive: true,
          updatedAt: now
        }
      });

    return {
      providerId: input.providerId,
      providerType: input.providerType,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey
    };
  }

  async createTenant(input: CreateTenantInput): Promise<TenantRecord> {
    await this.ensureSeeded();
    if (await this.tenantExists(input.tenantId)) {
      throw new ConflictError(`Tenant ${input.tenantId} already exists`);
    }
    const now = new Date();
    await this.pgOrm.insert(tenants).values({
      id: input.tenantId,
      name: input.tenantName ?? input.tenantId,
      status: "active",
      createdAt: now
    });
    return {
      id: input.tenantId,
      name: input.tenantName ?? input.tenantId,
      status: "active",
      createdAt: now.toISOString()
    };
  }

  async listTenants(): Promise<TenantRecord[]> {
    await this.ensureSeeded();
    const rows = await this.pgOrm
      .select({
        id: tenants.id,
        name: tenants.name,
        status: tenants.status,
        created_at: tenants.createdAt
      })
      .from(tenants);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: toIsoDate(row.created_at) ?? ""
    }));
  }

  async listProjects(tenantId?: string): Promise<ProjectRecord[]> {
    await this.ensureSeeded();
    const rows = tenantId
      ? await this.pgOrm
          .select({
            id: projects.id,
            tenant_id: projects.tenantId,
            name: projects.name,
            status: projects.status,
            created_at: projects.createdAt
          })
          .from(projects)
          .where(eq(projects.tenantId, tenantId))
      : await this.pgOrm
          .select({
            id: projects.id,
            tenant_id: projects.tenantId,
            name: projects.name,
            status: projects.status,
            created_at: projects.createdAt
          })
          .from(projects);

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      status: row.status,
      createdAt: toIsoDate(row.created_at) ?? ""
    }));
  }

  async createProject(input: CreateProjectInput): Promise<SeedResult> {
    await this.ensureSeeded();
    if (!(await this.tenantExists(input.tenantId))) {
      throw new NotFoundError(`Tenant ${input.tenantId} not found`);
    }
    if (await this.projectExists(input.projectId)) {
      throw new ConflictError(`Project ${input.projectId} already exists`);
    }

    const now = new Date();
    const scope = input.scope ?? "chat.write,usage.read";
    const tokenLimit = input.tokenLimit ?? this.defaultTokenLimit;
    const costLimit = input.costLimit ?? this.defaultCostLimit;
    const apiKey = generateApiKeyRaw();
    const apiKeyId = `api-key-${randomUUID()}`;

    await this.pgOrm.transaction(async (tx) => {
      await tx.insert(projects).values({
        id: input.projectId,
        tenantId: input.tenantId,
        name: input.projectName ?? input.projectId,
        status: "active",
        createdAt: now
      });
      await tx.insert(apiKeys).values({
        id: apiKeyId,
        projectId: input.projectId,
        keyHash: hashApiKey(apiKey),
        keyPrefix: apiKey.slice(0, 8),
        status: "active",
        scope,
        createdBy: input.createdBy ?? null,
        createdAt: now
      });
      await tx.insert(projectQuotas).values({
        projectId: input.projectId,
        tokenLimit,
        tokenUsed: 0,
        costLimit: String(costLimit),
        costUsed: "0",
        updatedAt: now
      });
    });

    return {
      tenantId: input.tenantId,
      projectId: input.projectId,
      apiKeyId,
      apiKey
    };
  }

  async createApiKey(input: CreateApiKeyInput): Promise<{ apiKeyId: string; apiKey: string; projectId: string }> {
    await this.ensureSeeded();
    const project = await this.getProject(input.projectId);
    if (!project) {
      throw new NotFoundError(`Project ${input.projectId} not found`);
    }
    const scope = input.scope ?? "chat.write,usage.read";
    const { apiKeyId, apiKey } = await this.insertApiKeyRecord(input.projectId, scope, input.createdBy);
    return { apiKeyId, apiKey, projectId: input.projectId };
  }

  async listApiKeys(projectId: string): Promise<ApiKeyListItem[]> {
    await this.ensureSeeded();
    const project = await this.getProject(projectId);
    if (!project) {
      throw new NotFoundError(`Project ${projectId} not found`);
    }

    const rows = await this.pgOrm
      .select({
        id: apiKeys.id,
        project_id: apiKeys.projectId,
        key_prefix: apiKeys.keyPrefix,
        status: apiKeys.status,
        scope: apiKeys.scope,
        created_by: apiKeys.createdBy,
        expires_at: apiKeys.expiresAt,
        revoked_at: apiKeys.revokedAt,
        last_used_at: apiKeys.lastUsedAt,
        last_used_ip: apiKeys.lastUsedIp,
        created_at: apiKeys.createdAt
      })
      .from(apiKeys)
      .where(eq(apiKeys.projectId, projectId));

    return rows.map((row) => this.mapApiKeyListItem(row));
  }

  async revokeApiKey(apiKeyId: string): Promise<ApiKeyListItem> {
    await this.ensureSeeded();
    const rows = await this.pgOrm
      .select({
        id: apiKeys.id,
        project_id: apiKeys.projectId,
        key_prefix: apiKeys.keyPrefix,
        status: apiKeys.status,
        scope: apiKeys.scope,
        created_by: apiKeys.createdBy,
        expires_at: apiKeys.expiresAt,
        revoked_at: apiKeys.revokedAt,
        last_used_at: apiKeys.lastUsedAt,
        last_used_ip: apiKeys.lastUsedIp,
        created_at: apiKeys.createdAt
      })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`API key ${apiKeyId} not found`);
    }
    if (row.revoked_at) {
      return this.mapApiKeyListItem(row);
    }

    const now = new Date();
    await this.pgOrm
      .update(apiKeys)
      .set({ status: "revoked", revokedAt: now })
      .where(eq(apiKeys.id, apiKeyId));

    return this.mapApiKeyListItem({
      ...row,
      status: "revoked",
      revoked_at: now
    });
  }

  async rotateApiKey(apiKeyId: string, createdBy?: string): Promise<{ apiKeyId: string; apiKey: string; projectId: string }> {
    await this.ensureSeeded();
    const rows = await this.pgOrm
      .select({
        id: apiKeys.id,
        project_id: apiKeys.projectId,
        scope: apiKeys.scope,
        revoked_at: apiKeys.revokedAt
      })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`API key ${apiKeyId} not found`);
    }
    if (!row.revoked_at) {
      await this.revokeApiKey(apiKeyId);
    }

    const { apiKeyId: newId, apiKey } = await this.insertApiKeyRecord(row.project_id, row.scope, createdBy);
    return { apiKeyId: newId, apiKey, projectId: row.project_id };
  }

  async touchApiKeyUsage(apiKeyId: string, ip?: string): Promise<void> {
    const now = new Date();
    await this.pgOrm
      .update(apiKeys)
      .set({
        lastUsedAt: now,
        lastUsedIp: ip ?? null
      })
      .where(eq(apiKeys.id, apiKeyId));
  }

  async createTenantProjectApiKey(seed: TenantProjectApiKeySeed): Promise<SeedResult> {
    await this.ensureSeeded();
    if (await this.projectExists(seed.projectId)) {
      throw new ConflictError(`Project ${seed.projectId} already exists`);
    }

    const now = new Date();
    const scope = seed.scope ?? "chat.write,usage.read";
    const tokenLimit = seed.tokenLimit ?? this.defaultTokenLimit;
    const costLimit = seed.costLimit ?? this.defaultCostLimit;
    const apiKey = seed.apiKey ?? generateApiKeyRaw();
    const apiKeyId = `api-key-${randomUUID()}`;

    await this.pgOrm.transaction(async (tx) => {
      if (!(await this.tenantExists(seed.tenantId))) {
        await tx.insert(tenants).values({
          id: seed.tenantId,
          name: seed.tenantName ?? seed.tenantId,
          status: "active",
          createdAt: now
        });
      } else if (seed.tenantName) {
        const existingTenant = await tx
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, seed.tenantId))
          .limit(1);
        if (existingTenant[0] && existingTenant[0].name !== seed.tenantName) {
          throw new ConflictError(`Tenant ${seed.tenantId} already exists with a different name`);
        }
      }

      await tx.insert(projects).values({
        id: seed.projectId,
        tenantId: seed.tenantId,
        name: seed.projectName ?? seed.projectId,
        status: "active",
        createdAt: now
      });
      await tx.insert(apiKeys).values({
        id: apiKeyId,
        projectId: seed.projectId,
        keyHash: hashApiKey(apiKey),
        keyPrefix: apiKey.slice(0, 8),
        status: "active",
        scope,
        createdBy: seed.createdBy ?? null,
        createdAt: now
      });
      await tx.insert(projectQuotas).values({
        projectId: seed.projectId,
        tokenLimit,
        tokenUsed: 0,
        costLimit: String(costLimit),
        costUsed: "0",
        updatedAt: now
      });
    });

    return {
      tenantId: seed.tenantId,
      projectId: seed.projectId,
      apiKeyId,
      apiKey
    };
  }
}
