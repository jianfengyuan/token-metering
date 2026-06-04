import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

function resolveDefaultDbPath(): string {
  return path.resolve(process.cwd(), "data", "token-metering.db");
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function createDatabase(dbPath?: string): Database.Database {
  const targetPath = dbPath ?? process.env.DATABASE_PATH ?? resolveDefaultDbPath();
  if (targetPath !== ":memory:") {
    ensureParentDir(targetPath);
  }
  const db = new Database(targetPath);
  db.pragma("journal_mode = WAL");
  return db;
}
