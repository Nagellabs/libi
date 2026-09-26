// The dev-catalog switch's column (settings.templates_catalog) comes from a
// generated migration, and an install that predates it keeps every setting.
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

const MIGRATIONS = path.resolve(process.cwd(), "drizzle/sqlite");

describe("settings.templates_catalog migration", () => {
  it("adds a nullable text column, leaving existing settings rows untouched", () => {
    const raw = new Database(":memory:");
    migrate(drizzle(raw), { migrationsFolder: MIGRATIONS });
    const cols = raw.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
    const col = cols.find((c) => c.name === "templates_catalog");
    expect({ ...col, type: col?.type.toLowerCase() }).toMatchObject({ type: "text", notnull: 0, dflt_value: null });
    // Installed templates already remember the catalog they came from (templates.cloud_source, 0068 + its 0069 backfill).
    expect((raw.prepare("PRAGMA table_info(templates)").all() as Array<{ name: string }>).map((c) => c.name)).toContain("cloud_source");
    raw.prepare("INSERT INTO settings (id, templates_author) VALUES (1, 'x')").run();
    expect(raw.prepare("SELECT templates_author, templates_catalog FROM settings WHERE id = 1").get()).toEqual({ templates_author: "x", templates_catalog: null });
  });
});
