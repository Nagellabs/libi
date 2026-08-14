import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { migrateDatabase, resetDbClient, getDb } from "@/lib/db/client";

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
});
