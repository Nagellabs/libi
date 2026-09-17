// The downgrade guard's two readers (lib/runtime/db-schema-version.ts).
//
// Both are exercised against REAL files: the point of the module is that it can
// answer "which schema wrote this database" with `fs` alone, before any
// better-sqlite3 binding exists to open it with, so a mocked fs would test
// nothing that matters.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import {
  isDbSchemaTooNew,
  migrationsFolderIn,
  readDbSchemaVersion,
  readRuntimeSchemaVersion,
} from "@/lib/runtime/db-schema-version";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-schema-version-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeDb(userVersion: number | null): string {
  const dbPath = path.join(tmp, "libi.sqlite");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE t (a INTEGER)");
  if (userVersion !== null) db.pragma(`user_version = ${userVersion}`);
  db.close();
  return dbPath;
}

function makeJournal(indices: number[]): string {
  const folder = migrationsFolderIn(tmp);
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({ entries: indices.map((idx) => ({ idx, tag: `00${idx}_x` })) }),
  );
  return folder;
}

describe("readDbSchemaVersion", () => {
  it("reads back what SQLite wrote, without opening the database", () => {
    expect(readDbSchemaVersion(makeDb(52))).toBe(52);
  });

  it("reads 0 from a database that was never stamped", () => {
    // The pre-guard state: every database migrated before this shipped. It must
    // read as OLDER than anything, never as unknown-and-scary.
    expect(readDbSchemaVersion(makeDb(null))).toBe(0);
  });

  it("has no opinion when there is no database yet", () => {
    expect(readDbSchemaVersion(path.join(tmp, "absent.sqlite"))).toBeNull();
  });

  it("has no opinion about a 0-byte file", () => {
    // better-sqlite3 creates the file on open with no `fileMustExist` guard, so
    // a first run genuinely leaves one of these behind.
    const empty = path.join(tmp, "empty.sqlite");
    fs.writeFileSync(empty, "");
    expect(readDbSchemaVersion(empty)).toBeNull();
  });

  it("has no opinion about a file that is not a SQLite database", () => {
    const junk = path.join(tmp, "junk.sqlite");
    fs.writeFileSync(junk, "x".repeat(4096));
    expect(readDbSchemaVersion(junk)).toBeNull();
  });
});

describe("readRuntimeSchemaVersion", () => {
  it("is the highest migration index in the journal", () => {
    expect(readRuntimeSchemaVersion(makeJournal([0, 1, 50, 51, 52]))).toBe(52);
  });

  it("is null when there is no journal to read", () => {
    expect(readRuntimeSchemaVersion(path.join(tmp, "nowhere"))).toBeNull();
  });

  it("is null for a journal with no entries", () => {
    expect(readRuntimeSchemaVersion(makeJournal([]))).toBeNull();
  });

  it("agrees with this repo's own migrations folder", () => {
    // Pins the reader against the real artifact rather than a fixture, so a
    // change to drizzle's journal shape fails here instead of in production.
    const real = readRuntimeSchemaVersion(migrationsFolderIn(process.cwd()));
    expect(real).toBeTypeOf("number");
    expect(real as number).toBeGreaterThanOrEqual(52);
  });
});

describe("isDbSchemaTooNew", () => {
  it("is true only when the database is ahead of the runtime", () => {
    expect(isDbSchemaTooNew(52, 50)).toBe(true);
    expect(isDbSchemaTooNew(52, 52)).toBe(false);
    expect(isDbSchemaTooNew(50, 52)).toBe(false);
  });

  it("fails OPEN when either side is unknown", () => {
    // A guard that can itself refuse to boot on a missing file is a worse bug
    // than the one it prevents.
    expect(isDbSchemaTooNew(null, 50)).toBe(false);
    expect(isDbSchemaTooNew(52, null)).toBe(false);
    expect(isDbSchemaTooNew(null, null)).toBe(false);
  });
});
