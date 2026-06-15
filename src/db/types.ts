export type DbDialect = "postgres";

export type DbParams = Record<string, unknown>;

export interface DatabaseClient {
  readonly dialect: DbDialect;
  readonly nativeClient?: unknown;
  run(sql: string, params?: DbParams): Promise<void>;
  queryMany<T extends Record<string, unknown>>(sql: string, params?: DbParams): Promise<T[]>;
  queryOne<T extends Record<string, unknown>>(sql: string, params?: DbParams): Promise<T | undefined>;
  exec(sql: string): Promise<void>;
  transaction<T>(handler: (tx: DatabaseClient) => Promise<T>): Promise<T>;
}
