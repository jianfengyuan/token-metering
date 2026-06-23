import fs from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import type { DatabaseClient, DbParams } from "./types.js";

interface CompiledQuery {
  text: string;
  values: unknown[];
}

function compileNamedQuery(sql: string, params: DbParams = {}): CompiledQuery {
  const positions = new Map<string, number>();
  const values: unknown[] = [];
  const text = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_full, rawName: string) => {
    const name = String(rawName);
    const existing = positions.get(name);
    if (existing) {
      return `$${existing}`;
    }
    const next = positions.size + 1;
    positions.set(name, next);
    const value = params[name];
    values.push(value === undefined ? null : value);
    return `$${next}`;
  });
  return { text, values };
}

class PostgresClient implements DatabaseClient {
  readonly dialect = "postgres" as const;
  readonly nativeClient: Pool;

  constructor(
    private readonly pool: Pool,
    private readonly executor: Pool | PoolClient = pool,
    private readonly inTransaction = false
  ) {
    this.nativeClient = pool;
  }

  async run(sql: string, params: DbParams = {}): Promise<void> {
    const compiled = compileNamedQuery(sql, params);
    await this.executor.query(compiled.text, compiled.values);
  }

  async queryMany<T extends Record<string, unknown>>(sql: string, params: DbParams = {}): Promise<T[]> {
    const compiled = compileNamedQuery(sql, params);
    const result = await this.executor.query(compiled.text, compiled.values);
    return result.rows as T[];
  }

  async queryOne<T extends Record<string, unknown>>(sql: string, params: DbParams = {}): Promise<T | undefined> {
    const rows = await this.queryMany<T>(sql, params);
    return rows[0];
  }

  async exec(sql: string): Promise<void> {
    await this.executor.query(sql);
  }

  async transaction<T>(handler: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      return handler(this);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const txClient = new PostgresClient(this.pool, client, true);
      const result = await handler(txClient);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

let schemaInitPromise: Promise<void> | null = null;

async function ensurePostgresSchema(client: PostgresClient): Promise<void> {
  if (!schemaInitPromise) {
    schemaInitPromise = (async () => {
      const schemaPath = path.resolve(process.cwd(), "src", "db", "postgres", "init.sql");
      await client.exec(fs.readFileSync(schemaPath, "utf8"));
    })().catch((error) => {
      schemaInitPromise = null;
      throw error;
    });
  }
  await schemaInitPromise;
}

async function resetPostgresForTests(client: PostgresClient): Promise<void> {
  if (!(process.env.NODE_ENV === "test" || process.env.VITEST)) {
    return;
  }
  await client.exec(`
    TRUNCATE TABLE
      usage_daily_rollups,
      usage_events,
      audit_events,
      project_quotas,
      api_keys,
      upstream_providers,
      model_provider_routes,
      projects,
      tenants
    RESTART IDENTITY CASCADE
  `);
}

function resolvePostgresConnectionString(): string {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString && connectionString.trim().length > 0) {
    return connectionString;
  }

  const host = process.env.PGHOST ?? process.env.PG_HOST;
  const port = process.env.PGPORT ?? process.env.PG_PORT ?? "5432";
  const user = process.env.PGUSER ?? process.env.PG_USER;
  const password = process.env.PGPASSWORD ?? process.env.PG_PASSWORD;
  const database = process.env.PGDATABASE ?? process.env.PG_DATABASE;

  if (!host || !user || !database) {
    throw new Error(
      "PostgreSQL requires DATABASE_URL or PGHOST/PGUSER/PGDATABASE (PG_PASSWORD optional but recommended)"
    );
  }
  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password ?? "");
  const encodedHost = encodeURIComponent(host);
  const encodedDatabase = encodeURIComponent(database);
  if (password && password.length > 0) {
    return `postgresql://${encodedUser}:${encodedPassword}@${encodedHost}:${port}/${encodedDatabase}`;
  }
  return `postgresql://${encodedUser}@${encodedHost}:${port}/${encodedDatabase}`;
}

async function createPostgresClient(): Promise<DatabaseClient> {
  const pool = new Pool({
    connectionString: resolvePostgresConnectionString(),
    max: Number(process.env.PG_POOL_MAX ?? "10")
  });
  const client = new PostgresClient(pool);
  try {
    await client.queryOne<{ ok: number }>("SELECT 1 AS ok");
    await ensurePostgresSchema(client);
    await resetPostgresForTests(client);
    return client;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export async function createDatabase(): Promise<DatabaseClient> {
  return createPostgresClient();
}
