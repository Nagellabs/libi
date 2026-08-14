import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "fs";
import path from "path";
import * as schema from "./schema/sqlite";
import { seedDatabase } from "./init";
import { resolveNativeBinding } from "./native-binding";
import { getLibiDbPath } from "@/lib/libi-home";

export type DbClient = BetterSQLite3Database<typeof schema>;

const globalForDrizzle = globalThis as unknown as { __drizzle_db?: DbClient };

declare global {
  var __libi_test_db: unknown | undefined;
}

export function getDbPath(): string {
  return process.env.DB_PATH || getLibiDbPath();
}

export function getMigrationsFolder(): string {
  return path.join(process.cwd(), "drizzle/sqlite");
}

const MAX_BACKUPS = 3;

export interface BackupInfo {
  path: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
}

/** List all backup files for the DB, sorted newest first */
export function listBackups(dbPath?: string): BackupInfo[] {
  const p = dbPath ?? getDbPath();
  const dir = path.dirname(p);
  const base = path.basename(p);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.backup-`))
      .map((f) => {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        return { path: full, filename: f, createdAt: stat.mtime.toISOString(), sizeBytes: stat.size };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

/** Delete oldest backups beyond MAX_BACKUPS */
function pruneBackups(dbPath: string): void {
  const backups = listBackups(dbPath);
  for (const old of backups.slice(MAX_BACKUPS)) {
    try {
      fs.unlinkSync(old.path);
      // stderr, not stdout — this code also runs inside MCP stdio child
      // processes where stdout is reserved for JSON-RPC.
      console.error(`[libi] Pruned old backup: ${old.filename}`);
    } catch {
      // ignore
    }
  }
}

export function backupDb(dbPath?: string): string | null {
  const p = dbPath ?? getDbPath();
  try {
    if (!fs.existsSync(p)) return null;
    // A 0-byte file is not a database — better-sqlite3 CREATES the file on
    // open with no `fileMustExist` guard, so anything that touches the
    // connection before the first migration leaves an empty file behind.
    // Copying it produced a 0-byte "backup" on every genuinely-first install:
    // it protects nothing, burns one of only 3 retained backup slots, and
    // prints a "Database backed up to …" line that reads as though prior user
    // data existed. Verified on a clean-prefix install of the npm tarball.
    if (fs.statSync(p).size === 0) return null;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${p}.backup-${timestamp}`;
    fs.copyFileSync(p, backupPath);
    // stderr, not stdout — see note in pruneBackups above.
    console.error(`[libi] Database backed up to ${backupPath}`);
    pruneBackups(p);
    return backupPath;
  } catch {
    console.warn("[libi] Failed to back up database before migration");
    return null;
  }
}

/**
 * Connection options shared by every `drizzle()` call here.
 *
 * `nativeBinding` is present only in the packaged Electron app's MCP stdio
 * child — a real-node process loading a runtime snapshot whose default
 * better-sqlite3 binding is Electron's. See `lib/db/native-binding.ts`; drizzle
 * forwards every key but `source` to better-sqlite3's `Database` constructor.
 */
function connectionOptions(dbPath: string): { source: string; nativeBinding?: string } {
  const nativeBinding = resolveNativeBinding();
  return nativeBinding ? { source: dbPath, nativeBinding } : { source: dbPath };
}

function createClient(): DbClient {
  const dbPath = getDbPath();
  return drizzle({ connection: connectionOptions(dbPath), schema });
}

/** Run migrations + seed against the given database path. Throws on
 *  failure — callers (the lifecycle prelude) decide what to do. */
export function migrateDatabase(
  dbPath: string = getDbPath(),
  migrationsFolder: string = getMigrationsFolder(),
): void {
  backupDb(dbPath);
  const db = drizzle({ connection: connectionOptions(dbPath), schema });
  // better-sqlite3 enables foreign keys ON by default. drizzle's table-recreate
  // migrations (the `__new_*` / DROP / RENAME pattern) and DROP-of-a-referenced-
  // table steps require FK enforcement OFF — otherwise dropping a parent table
  // hits a constraint violation (or cascade-deletes child rows). The
  // `PRAGMA foreign_keys=OFF` each migration emits is a no-op because drizzle
  // wraps the whole migration in a transaction (SQLite ignores that pragma
  // inside a txn). Disable it on the raw connection BEFORE migrate() opens its
  // transaction; the value persists for the duration. This throwaway migration
  // connection is closed below — the runtime connection from createClient()
  // keeps FK on, so app-level cascade behavior is unchanged.
  (db as unknown as { $client: { pragma(s: string): void } }).$client.pragma(
    "foreign_keys = OFF",
  );
  migrate(db, { migrationsFolder });
  seedDatabase(db);
  // Close the migration connection; subsequent getDb() will open its own.
  try {
    (db as unknown as { $client: { close(): void } }).$client.close();
  } catch {
    /* ignore */
  }
}

export function getDb(): DbClient {
  if (process.env.NODE_ENV === "test" && globalThis.__libi_test_db) {
    return globalThis.__libi_test_db as DbClient;
  }
  if (!globalForDrizzle.__drizzle_db) {
    globalForDrizzle.__drizzle_db = createClient();
  }
  return globalForDrizzle.__drizzle_db;
}

/** Close the DB connection and clear the singleton (used after a DB reset) */
export function resetDbClient(): void {
  const existing = globalForDrizzle.__drizzle_db;
  if (existing) {
    try {
      (existing as unknown as { $client: { close(): void } }).$client.close();
    } catch {
      // ignore — connection may already be closed
    }
  }
  globalForDrizzle.__drizzle_db = undefined;
}
