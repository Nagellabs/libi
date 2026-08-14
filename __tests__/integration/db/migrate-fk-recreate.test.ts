import { describe, it, expect, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Regression for the asset-folders migration (0029) failing on populated DBs.
 *
 * better-sqlite3 enables `foreign_keys` ON by default. Migration 0029 drops the
 * `assets` table (still referenced by `files.asset_id` ON DELETE NO ACTION) and
 * recreates `files`. With FK enforcement on, `DROP TABLE assets` raises
 * "FOREIGN KEY constraint failed" the moment any `files` row references an asset
 * — and the `PRAGMA foreign_keys=OFF` each migration emits is a no-op because
 * drizzle wraps the migration in a transaction.
 *
 * `migrateDatabase` (lib/db/client.ts) disables FK on the raw connection before
 * `migrate()` opens its transaction. These tests assert the real migration chain
 * applies on populated data with FK off, and prove the failure mode with FK on.
 *
 * The in-memory unit DB (test-db.ts) builds tables directly and never runs the
 * migrations, so it could not catch this.
 */

const REAL_MIGRATIONS = path.resolve(process.cwd(), "drizzle/sqlite");

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Copy the real migrations folder but drop the 0029 entry AND every migration
 *  after it, yielding the pre-asset-folders schema (assets table +
 *  files.asset_id present). Dropping only 0029 would leave a later migration
 *  (e.g. 0030) recorded in __drizzle_migrations with a newer timestamp, which
 *  makes the subsequent full migrate() skip the re-introduced 0029. */
const ASSET_FOLDERS_IDX = 29; // migration 0029 introduces asset_folders

function buildPreMigrations(): string {
  const dir = mkTmp("libi-mig-pre-");
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  const journal = JSON.parse(
    fs.readFileSync(path.join(REAL_MIGRATIONS, "meta", "_journal.json"), "utf-8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const keptTags = new Set(
    journal.entries.filter((e) => e.idx < ASSET_FOLDERS_IDX).map((e) => e.tag),
  );
  for (const f of fs.readdirSync(REAL_MIGRATIONS)) {
    const src = path.join(REAL_MIGRATIONS, f);
    if (f.endsWith(".sql")) {
      const tag = f.replace(/\.sql$/, "");
      if (!keptTags.has(tag)) continue; // exclude 0029 and everything after it
      fs.copyFileSync(src, path.join(dir, f));
    }
  }
  journal.entries = journal.entries.filter((e) => e.idx < ASSET_FOLDERS_IDX);
  fs.writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify(journal),
    "utf-8",
  );
  // snapshots are not read by the runtime migrator; skip copying them.
  return dir;
}

function seedPreState(dbFile: string): void {
  const d = drizzle({ connection: { source: dbFile } });
  d.$client.pragma("foreign_keys = OFF");
  migrate(d, { migrationsFolder: buildPreMigrations() });
  // A piece, an asset, and a file that references the asset (the row that makes
  // DROP TABLE assets violate the files.asset_id FK under enforcement).
  d.$client.exec(`INSERT INTO pieces (id, name) VALUES ('p1', 'Piece 1');`);
  d.$client.exec(
    `INSERT INTO assets (id, piece_id, name, kind) VALUES ('a1', 'p1', 'Asset 1', 'image');`,
  );
  d.$client.exec(
    `INSERT INTO files (id, piece_id, asset_id, filename, name, description, type, storage_path)
     VALUES ('f1', 'p1', 'a1', 'f1.png', 'F1', '', 'image', 'p1/f1.png');`,
  );
  d.$client.close();
}

afterEach(() => {
  while (tmpDirs.length) {
    try {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("migration 0029 on a populated DB", () => {
  it("applies with FK disabled (the migrateDatabase contract) and preserves data", () => {
    const dbDir = mkTmp("libi-mig-db-");
    const dbFile = path.join(dbDir, "libi.sqlite");
    seedPreState(dbFile);

    const d = drizzle({ connection: { source: dbFile } });
    d.$client.pragma("foreign_keys = OFF"); // what migrateDatabase does
    expect(() => migrate(d, { migrationsFolder: REAL_MIGRATIONS })).not.toThrow();

    const tables = d.$client
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("asset_folders");
    expect(tables).not.toContain("assets");

    const fileCols = d.$client
      .prepare("SELECT name FROM pragma_table_info('files')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(fileCols).toContain("folder_id");
    expect(fileCols).not.toContain("asset_id");

    // The seeded file row survives the table-recreate, landing at root.
    const row = d.$client
      .prepare("SELECT id, folder_id FROM files WHERE id = 'f1'")
      .get() as { id: string; folder_id: string | null } | undefined;
    expect(row?.id).toBe("f1");
    expect(row?.folder_id).toBeNull();
    d.$client.close();
  });

  it("FAILS with foreign keys enabled (proves the bug the fix prevents)", () => {
    const dbDir = mkTmp("libi-mig-db-on-");
    const dbFile = path.join(dbDir, "libi.sqlite");
    seedPreState(dbFile);

    const d = drizzle({ connection: { source: dbFile } });
    d.$client.pragma("foreign_keys = ON"); // better-sqlite3 default — the bug
    expect(() => migrate(d, { migrationsFolder: REAL_MIGRATIONS })).toThrow();
    d.$client.close();
  });
});
