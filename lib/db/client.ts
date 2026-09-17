import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "fs";
import path from "path";
import * as schema from "./schema/sqlite";
import { seedDatabase } from "./init";
import { migrateProviderRows } from "./migrate-providers";
import { resolveNativeBinding } from "./native-binding";
import {
  isDbSchemaTooNew,
  readDbSchemaVersion,
  readRuntimeSchemaVersion,
} from "@/lib/runtime/db-schema-version";
import { getLibiDbPath } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";

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
      logger.info(
        { tag: "db", op: "backup_pruned", filename: old.filename },
        "pruned an old database backup",
      );
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
    // Neither of these may use `console` at all. This code runs inside MCP
    // stdio children, where stdout is reserved for JSON-RPC — which is why
    // they were `console.error` — but inside the Next process `next-logger`
    // patches `console.error` to pino's ERROR level, so a routine
    // pre-migration backup was logged as an ERROR on EVERY warm boot. The
    // structured logger writes to `<LIBI_HOME>/logs/libi.log` on its own fd:
    // right level, and no stream to corrupt.
    logger.info(
      { tag: "db", op: "backup_created", path: backupPath },
      "database backed up before migration",
    );
    pruneBackups(p);
    return backupPath;
  } catch {
    logger.warn({ tag: "db", op: "backup_failed" }, "failed to back up the database before migration");
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

/**
 * This libi is OLDER than the database it was pointed at, so it stopped before
 * touching it.
 *
 * Carries its own boot hint because the generic `db-migrate` one cannot be
 * right for this case: a schema mismatch is the one database failure where
 * "reset the database" is exactly the wrong advice — the data is not damaged,
 * it is newer, and deleting it is the only way to actually lose it.
 */
export class DatabaseSchemaTooNewError extends Error {
  readonly hint: string;
  constructor(
    readonly dbPath: string,
    readonly dbSchemaVersion: number,
    readonly runtimeSchemaVersion: number,
  ) {
    super(
      `The database at ${dbPath} was written by a newer version of libi ` +
        `(schema ${dbSchemaVersion}); this build understands schema ` +
        `${runtimeSchemaVersion}. Refusing to run against it.`,
    );
    this.name = "DatabaseSchemaTooNewError";
    this.hint = [
      "This copy of libi is older than your data, so it stopped before changing anything.",
      "Your pieces, chats and settings are intact — do NOT delete the database.",
      "",
      "To get back to a working libi:",
      "  • Desktop app: install the latest release and reopen it.",
      "  • Terminal: run `npx @nagellabs/libi@latest`.",
      "",
      `Detail: database schema ${dbSchemaVersion}, this runtime understands ${runtimeSchemaVersion}.`,
    ].join("\n");
  }
}

/** Run migrations + seed against the given database path. Throws on
 *  failure — callers (the lifecycle prelude) decide what to do. */
export function migrateDatabase(
  dbPath: string = getDbPath(),
  migrationsFolder: string = getMigrationsFolder(),
): void {
  // ── Downgrade refusal — BEFORE the backup, and before anything opens the
  // database. Running an older libi against a migrated database is not
  // hypothetical: keeping the previous runtime on disk IS the rollback
  // mechanism (`lib/runtime/runtime-prune.ts`), and a shell update that bumps
  // Electron's ABI demotes every staged runtime at once. Drizzle's migrator
  // does not catch it — it only applies migrations newer than the newest
  // recorded one, so on a downgrade it runs nothing and reports success, and
  // the first write against the dropped column (migration 0051's
  // `mcp_servers.enabled`, in `seedDatabase`) throws instead.
  //
  // Ahead of `backupDb` on purpose: only 3 backups are retained, so a boot
  // loop here would otherwise roll the user's real backups off the end.
  const runtimeSchemaVersion = readRuntimeSchemaVersion(migrationsFolder);
  const dbSchemaVersion = readDbSchemaVersion(dbPath);
  if (isDbSchemaTooNew(dbSchemaVersion, runtimeSchemaVersion)) {
    logger.error(
      {
        tag: "db",
        op: "schema_too_new",
        dbSchemaVersion,
        runtimeSchemaVersion,
      },
      "refusing to run: the database was written by a newer libi",
    );
    throw new DatabaseSchemaTooNewError(
      dbPath,
      dbSchemaVersion as number,
      runtimeSchemaVersion as number,
    );
  }
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
  // Stamp the schema generation into SQLite's own `user_version` header field,
  // which is what the refusal above — and `electron/runtime-loader.ts`'s gate,
  // running before any runtime exists to open the database with — read. Written
  // here, immediately after the DDL it describes: `seedDatabase` below is data,
  // and a failure there must not leave the file claiming an older schema than
  // it physically has.
  if (runtimeSchemaVersion !== null) {
    (db as unknown as { $client: { pragma(s: string): void } }).$client.pragma(
      `user_version = ${runtimeSchemaVersion}`,
    );
  }
  // The DATA half of the providers migration — after the DDL, before the seed
  // (which would otherwise re-create nothing, but must never see stale rows).
  migrateProviderRows(db);
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
