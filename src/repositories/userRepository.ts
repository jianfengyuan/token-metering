import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { tenantMembers, tenants, users } from "../db/postgres/schema.js";
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

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  platformRole: string | null;
  status: string;
  createdAt: string;
}

export interface TenantMemberRecord {
  tenantId: string;
  userId: string;
  role: string;
  joinedAt: string;
  email?: string;
  name?: string;
}

export interface CreateUserInput {
  email: string;
  name: string;
  platformRole?: string | null;
  passwordHash?: string | null;
}

export interface UpdateUserInput {
  name?: string;
  platformRole?: string | null;
  status?: string;
  passwordHash?: string | null;
}

function toIsoDate(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

export class UserRepository {
  private readonly pgOrm: NodePgDatabase;

  constructor(db: DatabaseClient) {
    if (!db.nativeClient) {
      throw new Error("PostgreSQL native client is required");
    }
    this.pgOrm = drizzle(db.nativeClient as Pool);
  }

  private mapUser(row: {
    id: string;
    email: string;
    name: string;
    platform_role: string | null;
    status: string;
    created_at: Date | string;
  }): UserRecord {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      platformRole: row.platform_role,
      status: row.status,
      createdAt: toIsoDate(row.created_at)
    };
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const existing = await this.pgOrm
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictError(`User with email ${input.email} already exists`);
    }

    const now = new Date();
    const id = `user-${randomUUID()}`;
    await this.pgOrm.insert(users).values({
      id,
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash ?? null,
      platformRole: input.platformRole ?? null,
      status: "active",
      createdAt: now
    });

    return {
      id,
      email: input.email,
      name: input.name,
      platformRole: input.platformRole ?? null,
      status: "active",
      createdAt: now.toISOString()
    };
  }

  async listUsers(): Promise<UserRecord[]> {
    const rows = await this.pgOrm
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        platform_role: users.platformRole,
        status: users.status,
        created_at: users.createdAt
      })
      .from(users);

    return rows.map((row) => this.mapUser(row));
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    const rows = await this.pgOrm
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        platform_role: users.platformRole,
        status: users.status,
        created_at: users.createdAt
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const row = rows[0];
    return row ? this.mapUser(row) : null;
  }

  async updateUser(userId: string, input: UpdateUserInput): Promise<UserRecord> {
    const existing = await this.getUser(userId);
    if (!existing) {
      throw new NotFoundError(`User ${userId} not found`);
    }

    const patch: Partial<typeof users.$inferInsert> = {};
    if (input.name !== undefined) {
      patch.name = input.name;
    }
    if (input.platformRole !== undefined) {
      patch.platformRole = input.platformRole;
    }
    if (input.status !== undefined) {
      patch.status = input.status;
    }
    if (input.passwordHash !== undefined) {
      patch.passwordHash = input.passwordHash;
    }

    if (Object.keys(patch).length > 0) {
      await this.pgOrm.update(users).set(patch).where(eq(users.id, userId));
    }

    return (await this.getUser(userId))!;
  }

  async addTenantMember(tenantId: string, userId: string, role = "member"): Promise<TenantMemberRecord> {
    const tenantRows = await this.pgOrm
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (tenantRows.length === 0) {
      throw new NotFoundError(`Tenant ${tenantId} not found`);
    }

    const user = await this.getUser(userId);
    if (!user) {
      throw new NotFoundError(`User ${userId} not found`);
    }

    const existing = await this.pgOrm
      .select({ tenant_id: tenantMembers.tenantId })
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictError(`User ${userId} is already a member of tenant ${tenantId}`);
    }

    const now = new Date();
    await this.pgOrm.insert(tenantMembers).values({
      tenantId,
      userId,
      role,
      joinedAt: now
    });

    return {
      tenantId,
      userId,
      role,
      joinedAt: now.toISOString(),
      email: user.email,
      name: user.name
    };
  }

  async listTenantMembers(tenantId: string): Promise<TenantMemberRecord[]> {
    const rows = await this.pgOrm
      .select({
        tenant_id: tenantMembers.tenantId,
        user_id: tenantMembers.userId,
        role: tenantMembers.role,
        joined_at: tenantMembers.joinedAt,
        email: users.email,
        name: users.name
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(eq(tenantMembers.tenantId, tenantId));

    return rows.map((row) => ({
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.role,
      joinedAt: toIsoDate(row.joined_at),
      email: row.email,
      name: row.name
    }));
  }

  async updateTenantMemberRole(tenantId: string, userId: string, role: string): Promise<TenantMemberRecord> {
    const rows = await this.pgOrm
      .select({
        tenant_id: tenantMembers.tenantId,
        user_id: tenantMembers.userId,
        role: tenantMembers.role,
        joined_at: tenantMembers.joinedAt
      })
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new NotFoundError(`Member ${userId} not found in tenant ${tenantId}`);
    }

    await this.pgOrm
      .update(tenantMembers)
      .set({ role })
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)));

    const user = await this.getUser(userId);
    return {
      tenantId,
      userId,
      role,
      joinedAt: toIsoDate(row.joined_at),
      email: user?.email,
      name: user?.name
    };
  }

  async removeTenantMember(tenantId: string, userId: string): Promise<void> {
    const rows = await this.pgOrm
      .select({ tenant_id: tenantMembers.tenantId })
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundError(`Member ${userId} not found in tenant ${tenantId}`);
    }

    await this.pgOrm
      .delete(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)));
  }
}
