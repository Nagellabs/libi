import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { skills as skillsTable } from "@/lib/db/schema/sqlite";
import { getDb } from "@/lib/db/client";
import { setSkillsEnabledByTag } from "@/mcp/tools/skill-tools";

const ctx = { pieceId: "" } as never;
const parse = (r: { content: { text: string }[] }) =>
  JSON.parse(r.content[0].text);

describe("setSkillsEnabledByTag", () => {
  let homeRoot: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-bulk-tag-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = homeRoot;
    createTestDb();
    getDb()
      .insert(skillsTable)
      .values([
        {
          id: "1",
          name: "a",
          description: "d",
          source: "user",
          enabled: true,
          body: "x",
          frontmatter: "{}",
          tags: '["ugc"]',
        },
        {
          id: "2",
          name: "b",
          description: "d",
          source: "user",
          enabled: true,
          body: "x",
          frontmatter: "{}",
          tags: '["audio"]',
        },
      ])
      .run();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("disables only skills carrying a matching tag", async () => {
    const res = parse(
      await setSkillsEnabledByTag(ctx, { tags: ["ugc"], enabled: false }),
    );
    expect(res.affected).toEqual(["a"]);
    expect(
      getDb()
        .select()
        .from(skillsTable)
        .where(eq(skillsTable.id, "1"))
        .get()!.enabled,
    ).toBe(false);
    expect(
      getDb()
        .select()
        .from(skillsTable)
        .where(eq(skillsTable.id, "2"))
        .get()!.enabled,
    ).toBe(true);
  });

  it("enables skills matching any of the given tags", async () => {
    // disable both first
    getDb()
      .update(skillsTable)
      .set({ enabled: false })
      .where(eq(skillsTable.id, "1"))
      .run();
    getDb()
      .update(skillsTable)
      .set({ enabled: false })
      .where(eq(skillsTable.id, "2"))
      .run();

    const res = parse(
      await setSkillsEnabledByTag(ctx, {
        tags: ["ugc", "audio"],
        enabled: true,
      }),
    );
    expect(res.affected.sort()).toEqual(["a", "b"]);
    expect(
      getDb()
        .select()
        .from(skillsTable)
        .where(eq(skillsTable.id, "1"))
        .get()!.enabled,
    ).toBe(true);
    expect(
      getDb()
        .select()
        .from(skillsTable)
        .where(eq(skillsTable.id, "2"))
        .get()!.enabled,
    ).toBe(true);
  });

  it("returns empty affected when no skill matches", async () => {
    const res = parse(
      await setSkillsEnabledByTag(ctx, {
        tags: ["nonexistent"],
        enabled: false,
      }),
    );
    expect(res.affected).toEqual([]);
  });

  it("returns enabled in result payload", async () => {
    const res = parse(
      await setSkillsEnabledByTag(ctx, { tags: ["ugc"], enabled: false }),
    );
    expect(res.enabled).toBe(false);
  });
});
