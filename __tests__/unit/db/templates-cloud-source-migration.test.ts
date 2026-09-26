// The backfill of templates.cloud_source / template_uses.source: an existing
// link to a fixture seed id is test mode's, every other link and use the
// production site's (lib/templates/cloud/catalog-source.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCTION_SITE_URL } from "@/lib/site-url";
import { FIXTURE_CLOUD_IDS } from "@/lib/templates/cloud/test-fixture";

const MIGRATIONS = path.resolve(process.cwd(), "drizzle/sqlite");
const BACKFILL_TAG = "0069_templates_cloud_source_backfill";

/** A copy of the migrations folder that stops just before the backfill. */
function migrationsBefore(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-migrations-"));
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  const cut = journal.entries.findIndex((e) => e.tag === tag);
  expect(cut).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, cut);
  fs.mkdirSync(path.join(dir, "meta"));
  fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const e of entries) fs.copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("templates cloud-source backfill migration", () => {
  it("names every fixture seed id and the production origin", () => {
    const text = fs.readFileSync(path.join(MIGRATIONS, `${BACKFILL_TAG}.sql`), "utf8");
    for (const id of FIXTURE_CLOUD_IDS) expect(text).toContain(`'${id}'`);
    expect(text).toContain(`'${PRODUCTION_SITE_URL}'`);
  });

  it("tags fixture links test-mode and every other link and use production; unlinked rows stay null", () => {
    const before = migrationsBefore(BACKFILL_TAG);
    cleanup.push(before);
    const raw = new Database(":memory:");
    const db = drizzle(raw);
    migrate(db, { migrationsFolder: before });
    const insert = raw.prepare("INSERT INTO templates (id, name, origin, cloud_id, publish_pending) VALUES (?, ?, ?, ?, ?)");
    insert.run("fixture-installed", "F", "installed", FIXTURE_CLOUD_IDS[1], null);
    insert.run("real-published", "R", "local", "rrrrrrrrrrrrrrrrrrr5", null);
    insert.run("fixture-pending", "P", "local", null, JSON.stringify({ cloudId: FIXTURE_CLOUD_IDS[0], version: 1 }));
    insert.run("real-pending", "Q", "local", null, JSON.stringify({ cloudId: "qqqqqqqqqqqqqqqqqqq4", version: 1 }));
    insert.run("unreadable-pending", "U", "local", null, "{not json");
    insert.run("local-only", "L", "local", null, null);
    const use = raw.prepare("INSERT INTO template_uses (id, template_id) VALUES (?, ?)");
    use.run("u-fixture", "fixture-installed");
    use.run("u-real", "real-published");
    use.run("u-local", "local-only");

    migrate(db, { migrationsFolder: MIGRATIONS });
    const sources = Object.fromEntries(
      (raw.prepare("SELECT id, cloud_source FROM templates").all() as Array<{ id: string; cloud_source: string | null }>).map((r) => [r.id, r.cloud_source]),
    );
    expect(sources).toEqual({
      "fixture-installed": "test-mode",
      "real-published": PRODUCTION_SITE_URL,
      "fixture-pending": "test-mode",
      "real-pending": PRODUCTION_SITE_URL,
      // Unreadable: the record can't name an id, so it is not the fixture's.
      "unreadable-pending": PRODUCTION_SITE_URL,
      "local-only": null,
    });
    const uses = Object.fromEntries(
      (raw.prepare("SELECT id, source FROM template_uses").all() as Array<{ id: string; source: string | null }>).map((r) => [r.id, r.source]),
    );
    expect(uses).toEqual({ "u-fixture": "test-mode", "u-real": PRODUCTION_SITE_URL, "u-local": PRODUCTION_SITE_URL });
    raw.close();
  });
});
