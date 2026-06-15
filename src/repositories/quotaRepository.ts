import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { projectQuotas, projects } from "../db/postgres/schema.js";
import type { DatabaseClient } from "../db/types.js";

export interface QuotaReservation {
  tenantId: string;
  projectId: string;
  requestId: string;
  reservedTokens: number;
  reservedCost: number;
}

export class QuotaExceededError extends Error {
  readonly code = "QUOTA_EXCEEDED";

  constructor(message = "quota exceeded") {
    super(message);
    this.name = "QuotaExceededError";
  }
}

function clampNonNegative(value: number): number {
  return value < 0 ? 0 : value;
}

export class QuotaRepository {
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

  async reserve(reservation: QuotaReservation): Promise<void> {
    await this.pgOrm.transaction(async (tx) => {
      const rows = await tx
        .select({
          token_limit: projectQuotas.tokenLimit,
          token_used: projectQuotas.tokenUsed,
          cost_limit: projectQuotas.costLimit,
          cost_used: projectQuotas.costUsed
        })
        .from(projectQuotas)
        .innerJoin(projects, eq(projects.id, projectQuotas.projectId))
        .where(
          and(
            eq(projectQuotas.projectId, reservation.projectId),
            eq(projects.tenantId, reservation.tenantId),
            eq(projects.status, "active")
          )
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new Error("PROJECT_QUOTA_NOT_FOUND");
      }

      const tokenLimit = this.toNumber(row.token_limit);
      const tokenUsed = this.toNumber(row.token_used);
      const costLimit = this.toNumber(row.cost_limit);
      const costUsed = this.toNumber(row.cost_used);

      if (tokenLimit >= 0 && tokenUsed + reservation.reservedTokens > tokenLimit) {
        throw new QuotaExceededError("token quota exceeded");
      }
      if (costLimit >= 0 && costUsed + reservation.reservedCost > costLimit) {
        throw new QuotaExceededError("budget quota exceeded");
      }

      await tx
        .update(projectQuotas)
        .set({
          tokenUsed: sql`${projectQuotas.tokenUsed} + ${reservation.reservedTokens}`,
          costUsed: sql`${projectQuotas.costUsed} + ${reservation.reservedCost}`,
          updatedAt: new Date()
        })
        .where(eq(projectQuotas.projectId, reservation.projectId));
    });
  }

  async settleSuccess(
    reservation: QuotaReservation,
    actualUsage: {
      totalTokens: number;
      totalCost: number;
    }
  ): Promise<void> {
    const tokenDelta = actualUsage.totalTokens - reservation.reservedTokens;
    const costDelta = actualUsage.totalCost - reservation.reservedCost;
    await this.pgOrm
      .update(projectQuotas)
      .set({
        tokenUsed: sql`GREATEST(${projectQuotas.tokenUsed} + ${tokenDelta}, 0)`,
        costUsed: sql`GREATEST(${projectQuotas.costUsed} + ${costDelta}, 0)`,
        updatedAt: new Date()
      })
      .where(eq(projectQuotas.projectId, reservation.projectId));
  }

  async rollback(reservation: QuotaReservation): Promise<void> {
    const releaseTokens = clampNonNegative(reservation.reservedTokens);
    const releaseCost = clampNonNegative(reservation.reservedCost);
    await this.pgOrm
      .update(projectQuotas)
      .set({
        tokenUsed: sql`GREATEST(${projectQuotas.tokenUsed} - ${releaseTokens}, 0)`,
        costUsed: sql`GREATEST(${projectQuotas.costUsed} - ${releaseCost}, 0)`,
        updatedAt: new Date()
      })
      .where(eq(projectQuotas.projectId, reservation.projectId));
  }

  async getProjectQuota(projectId: string): Promise<{
    tokenLimit: number;
    tokenUsed: number;
    costLimit: number;
    costUsed: number;
  } | null> {
    const rows = await this.pgOrm
      .select({
        token_limit: projectQuotas.tokenLimit,
        token_used: projectQuotas.tokenUsed,
        cost_limit: projectQuotas.costLimit,
        cost_used: projectQuotas.costUsed
      })
      .from(projectQuotas)
      .where(eq(projectQuotas.projectId, projectId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      tokenLimit: this.toNumber(row.token_limit),
      tokenUsed: this.toNumber(row.token_used),
      costLimit: this.toNumber(row.cost_limit),
      costUsed: this.toNumber(row.cost_used)
    };
  }
}
