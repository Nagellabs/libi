import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sql } from "drizzle-orm";
import { TEMPLATES_FTS_MIGRATION_SQL } from "@/lib/db/templates-fts";

const MIGRATIONS = path.resolve(process.cwd(), "drizzle/sqlite");

describe("templates_fts custom migration", () => {
  it("is byte-identical to TEMPLATES_FTS_MIGRATION_SQL", () => {
    const file = fs.readdirSync(MIGRATIONS).find((f) => f.endsWith("_templates_fts.sql"));
    expect(file, "custom migration file missing").toBeDefined();
    expect(fs.readFileSync(path.join(MIGRATIONS, file!), "utf8")).toBe(TEMPLATES_FTS_MIGRATION_SQL);
  });

  it("applies on a fresh database together with every earlier migration", () => {
    const raw = new Database(":memory:");
    const db = drizzle(raw);
    migrate(db, { migrationsFolder: MIGRATIONS });
    const tables = db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name`).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["templates", "template_uses", "templates_fts", "templates_fts_ai", "templates_fts_ad", "templates_fts_au"]));
    raw.close();
  });
});
