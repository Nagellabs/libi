// __tests__/unit/templates/store-usage.test.ts
//
// D5: what a local template's page says about its use on this machine
// (`localUsage`), and which local row a public catalog entry already has here
// (`findInstalledTemplate` — this catalog's links only).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { makeScaffold } from "@/__tests__/helpers/templates";
import { getDb } from "@/lib/db/client";
import { templates, templateUses } from "@/lib/db/schema/sqlite";
import { catalogSource } from "@/lib/templates/cloud/catalog-source";
import { createTemplate, findInstalledTemplate, localUsage } from "@/lib/templates/store";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 25, 12, 0);
let home = "";

async function make(origin: "local" | "installed" = "local") {
  const t = await createTemplate({
    name: "Hook + caption",
    description: "Three seconds.",
    tags: ["hook"],
    scaffold: makeScaffold() as never,
    instructions: "# Purpose\nA hook.\n",
    copies: [],
    writes: [],
    origin,
  });
  return t.id;
}

/** One use at `at` (ms), with the row's counters moved the way recordUse moves them. */
function useAt(templateId: string, at: number) {
  const db = getDb();
  db.insert(templateUses).values({ templateId, pieceId: null, usedAt: new Date(at), source: catalogSource() }).run();
  const row = db.select().from(templates).where(eq(templates.id, templateId)).get()!;
  const last = row.lastUsedAt && row.lastUsedAt.getTime() > at ? row.lastUsedAt : new Date(at);
  db.update(templates).set({ useCount: row.useCount + 1, lastUsedAt: last }).where(eq(templates.id, templateId)).run();
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-store-usage-"));
  process.env.LIBI_HOME = home;
  createTestDb();
});
afterEach(() => {
  resetTestDb();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("localUsage", () => {
  it("total from the row, 7 d and 30 d from the use rows, last used from the row", async () => {
    const id = await make();
    useAt(id, NOW - 3 * DAY);
    useAt(id, NOW - 3 * DAY + 1000);
    useAt(id, NOW - 20 * DAY);
    expect(localUsage(id, NOW)).toEqual({ total: 3, d7: 2, d30: 3, lastUsedAt: new Date(NOW - 3 * DAY + 1000).toISOString() });
  });

  it("a use older than 30 days counts only in the total", async () => {
    const id = await make();
    useAt(id, NOW - 45 * DAY);
    expect(localUsage(id, NOW)).toMatchObject({ total: 1, d7: 0, d30: 0 });
  });

  it("an unused template: zeros and no last use", async () => {
    const id = await make();
    expect(localUsage(id, NOW)).toEqual({ total: 0, d7: 0, d30: 0, lastUsedAt: null });
  });
});

describe("findInstalledTemplate", () => {
  const CLOUD = "abcdefghijklmnopqrst";
  const link = (id: string, cloudSource: string | null = catalogSource()) =>
    getDb().update(templates).set({ cloudId: CLOUD, cloudSource }).where(eq(templates.id, id)).run();

  it("the installed copy of this catalog's entry", async () => {
    const id = await make("installed");
    link(id);
    expect(findInstalledTemplate(CLOUD)).toEqual({ id, origin: "installed" });
  });

  it("the author's own published template counts too — and says it is theirs (review M2)", async () => {
    const id = await make("local");
    link(id);
    expect(findInstalledTemplate(CLOUD)).toEqual({ id, origin: "local" });
  });

  it("null for a row linked to another catalog, and for an id nobody has", async () => {
    const id = await make("installed");
    link(id, "https://other-catalog.example");
    expect(findInstalledTemplate(CLOUD)).toBeNull();
    expect(findInstalledTemplate("zzzzzzzzzzzzzzzzzzzz")).toBeNull();
  });
});
