import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import {
  DatabaseSchemaTooNewError,
  getMigrationsFolder,
  migrateDatabase,
  resetDbClient,
  getDb,
  listBackups,
} from "@/lib/db/client";
import {
  readDbSchemaVersion,
  readRuntimeSchemaVersion,
} from "@/lib/runtime/db-schema-version";

describe("migrateDatabase", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-migrate-"));
    dbPath = path.join(tmpDir, "libi.sqlite");
    process.env.DB_PATH = dbPath;
    resetDbClient();
  });

  afterEach(() => {
    resetDbClient();
    delete process.env.DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates schema on a fresh DB and the file ends up readable", () => {
    migrateDatabase(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    // Smoke: after migrate, getDb() returns a working connection.
    const db = getDb();
    expect(db).toBeTruthy();
  });

  it("is idempotent on a second call against the same DB", () => {
    migrateDatabase(dbPath);
    expect(() => migrateDatabase(dbPath)).not.toThrow();
  });

  it("throws when the migrations folder is missing", () => {
    expect(() => migrateDatabase(dbPath, "/nonexistent/folder")).toThrow();
  });

  // ── The downgrade guard ──────────────────────────────────────
  // Migration 0051 does a real `DROP COLUMN`, so an older runtime meeting a
  // migrated database used to crash inside `seedDatabase` — in the FIRST fixed
  // boot step, under a banner that told the user to `rm -rf` their database.
  // Drizzle cannot catch it: its migrator only applies migrations newer than
  // the newest recorded one, so a downgrade runs nothing and reports success.

  it("stamps the schema generation into the database it migrated", () => {
    migrateDatabase(dbPath);
    expect(readDbSchemaVersion(dbPath)).toBe(readRuntimeSchemaVersion(getMigrationsFolder()));
  });

  it("refuses a database written by a NEWER libi, and says how to get back", () => {
    migrateDatabase(dbPath);
    // Exactly what a future release leaves behind for today's runtime.
    const raw = new Database(dbPath);
    raw.pragma(`user_version = ${(readRuntimeSchemaVersion(getMigrationsFolder()) ?? 0) + 1}`);
    raw.close();
    resetDbClient();

    let thrown: unknown;
    try {
      migrateDatabase(dbPath);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DatabaseSchemaTooNewError);
    const hint = (thrown as DatabaseSchemaTooNewError).hint;
    // The whole point: the remediation must not send the user at their data.
    expect(hint).not.toMatch(/rm -rf/);
    expect(hint).toMatch(/do NOT delete/i);
    expect(hint).toMatch(/latest/i);
  });

  it("refuses BEFORE writing a backup, so a boot loop cannot evict real ones", () => {
    migrateDatabase(dbPath);
    for (const b of listBackups(dbPath)) fs.rmSync(b.path, { force: true });
    const raw = new Database(dbPath);
    raw.pragma(`user_version = ${(readRuntimeSchemaVersion(getMigrationsFolder()) ?? 0) + 5}`);
    raw.close();
    resetDbClient();

    expect(() => migrateDatabase(dbPath)).toThrow(DatabaseSchemaTooNewError);
    expect(listBackups(dbPath)).toHaveLength(0);
  });

  it("still migrates a database stamped by an OLDER libi", () => {
    // Upgrade is the normal path and must not be caught by the guard.
    migrateDatabase(dbPath);
    const raw = new Database(dbPath);
    raw.pragma("user_version = 1");
    raw.close();
    resetDbClient();
    expect(() => migrateDatabase(dbPath)).not.toThrow();
    expect(readDbSchemaVersion(dbPath)).toBe(readRuntimeSchemaVersion(getMigrationsFolder()));
  });
});

describe("skill_installs table", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-skill-installs-"));
    dbPath = path.join(tmpDir, "libi.sqlite");
    process.env.DB_PATH = dbPath;
    resetDbClient();
  });

  afterEach(() => {
    resetDbClient();
    delete process.env.DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exists after migration with the recorded-install columns", () => {
    migrateDatabase(dbPath);
    const raw = new Database(dbPath);
    const cols = (raw.prepare("PRAGMA table_info(skill_installs)").all() as { name: string; notnull: number; dflt_value: string | null }[])
      .map((c) => [c.name, c.notnull, c.dflt_value]);
    raw.close();
    expect(cols).toEqual([
      ["id", 1, null],
      ["agent_id", 1, null],
      ["scope", 1, null],
      ["folder_path", 1, "''"],
      ["source", 1, null],
      // SQLite's PRAGMA table_info reports a function default without the schema's outer
      // parentheses: the column is declared `DEFAULT (unixepoch())` but this reads "unixepoch()".
      ["created_at", 1, "unixepoch()"],
      ["last_synced_at", 0, null],
      ["last_error", 0, null],
      ["skipped_names", 1, "'[]'"],
      ["last_root", 0, null],
    ]);
  });

  it("allows one user-level row per agent and one row per (agent, folder)", () => {
    migrateDatabase(dbPath);
    const raw = new Database(dbPath);
    const insert = raw.prepare(
      "INSERT INTO skill_installs (id, agent_id, scope, folder_path, source) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("a", "claude-code", "user", "", "ui");
    insert.run("b", "codex", "user", "", "ui");
    insert.run("c", "claude-code", "folder", "/p/one", "cli");
    expect(() => insert.run("d", "claude-code", "user", "", "cli")).toThrow(/UNIQUE/);
    expect(() => insert.run("e", "claude-code", "folder", "/p/one", "ui")).toThrow(/UNIQUE/);
    expect(() => insert.run("f", "codex", "folder", "/p/one", "ui")).not.toThrow();
    raw.close();
  });

  it("bumps the runtime schema version past the previous generation", () => {
    migrateDatabase(dbPath);
    expect(readRuntimeSchemaVersion(getMigrationsFolder())).toBeGreaterThanOrEqual(55);
    expect(readDbSchemaVersion(dbPath)).toBe(readRuntimeSchemaVersion(getMigrationsFolder()));
  });
});
