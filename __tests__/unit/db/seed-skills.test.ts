import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { seedDatabase } from "@/lib/db/init";
import { BUNDLED_SKILLS } from "@/mcp/skills/registry";
describe("seedDatabase bundled skills", () => {
  beforeEach(() => createTestDb());
  afterEach(() => resetTestDb());

  it("inserts every bundled skill row", () => {
    seedDatabase(getDb() as never);
    for (const def of BUNDLED_SKILLS) {
      const row = getDb().select().from(skills).where(eq(skills.id, def.id)).get();
      expect(row).toBeDefined();
      expect(row!.source).toBe("bundled");
      expect(row!.enabled).toBe(true);
    }
  });

  it("preserves user's enabled choice on re-seed", () => {
    seedDatabase(getDb() as never);
    const def = BUNDLED_SKILLS[0];
    // User disables it
    getDb().update(skills).set({ enabled: false }).where(eq(skills.id, def.id)).run();
    // Re-seed (e.g., on next startup)
    seedDatabase(getDb() as never);
    const row = getDb().select().from(skills).where(eq(skills.id, def.id)).get();
    expect(row!.enabled).toBe(false);
  });

  it("updates description on re-seed (refreshes registry changes)", () => {
    seedDatabase(getDb() as never);
    const def = BUNDLED_SKILLS[0];
    // Mutate description in DB to simulate stale row
    getDb().update(skills).set({ description: "stale" }).where(eq(skills.id, def.id)).run();
    // Re-seed
    seedDatabase(getDb() as never);
    const row = getDb().select().from(skills).where(eq(skills.id, def.id)).get();
    expect(row!.description).toBe(def.description);
  });

  it("seeds bundled skill tags from their SKILL.md frontmatter", () => {
    seedDatabase(getDb() as never);
    const row = getDb()
      .select()
      .from(skills)
      .where(eq(skills.name, "ai-asset-generation"))
      .get();
    expect(JSON.parse(row!.tags)).toContain("generation");
  });

  it("preserves a DB tag override on bundled skills across a re-seed (insert-only by design)", () => {
    seedDatabase(getDb() as never);
    // Simulate a UI tag override on a bundled skill.
    getDb().update(skills).set({ tags: '["custom-override"]' }).where(eq(skills.name, "ai-asset-generation")).run();
    // Re-seed (as happens on restart) must NOT clobber the override.
    seedDatabase(getDb() as never);
    const row = getDb().select().from(skills).where(eq(skills.name, "ai-asset-generation")).get();
    expect(JSON.parse(row!.tags)).toEqual(["custom-override"]);
  });

  // Regression guard: a bundled skill folder that exists on disk but is missing
  // from BUNDLED_SKILLS is never seeded → never enabled → never reaches the agent
  // (this is exactly how `using-storyboard` silently shipped unregistered).
  it("registers every on-disk bundled skill folder in BUNDLED_SKILLS", () => {
    const skillsDir = resolve(__dirname, "../../../mcp/skills");
    const onDisk = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(resolve(skillsDir, e.name, "SKILL.md")))
      .map((e) => e.name);
    const registered = new Set(BUNDLED_SKILLS.map((s) => s.name));
    const missing = onDisk.filter((name) => !registered.has(name));
    expect(missing).toEqual([]);
  });
});
