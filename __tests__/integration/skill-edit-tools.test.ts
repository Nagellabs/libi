import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { mcpLogger } from "@/lib/logger";

const syncMock = vi.fn(async () => {});
vi.mock("@/mcp/skills/sync-workspace", () => ({
  syncSkillsToWorkspace: () => syncMock(),
}));

import { addSkill, updateSkill } from "@/mcp/tools/skill-tools";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

const ORIGINAL_BODY = `---\nname: my-skill\ndescription: Original\n---\nOriginal body.\n`;
const UPDATED_BODY = `---\nname: my-skill\ndescription: Updated desc\n---\nUpdated body content.\n`;
const MISMATCH_BODY = `---\nname: other-name\ndescription: Whatever\n---\nBody.\n`;

describe("update_skill tool", () => {
  let homeRoot: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-edit-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = homeRoot;
    createTestDb();
    syncMock.mockClear();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("updates user skill body, description, frontmatter, and rewrites disk file", async () => {
    await addSkill({} as never, {
      name: "my-skill",
      description: "Original",
      body: ORIGINAL_BODY,
    });
    syncMock.mockClear();

    const res = await updateSkill({} as never, {
      name: "my-skill",
      body: UPDATED_BODY,
    });
    expect(res.error).toBeUndefined();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.data.name).toBe("my-skill");
    expect(payload.data.source).toBe("user");

    const row = getDb()
      .select()
      .from(skills)
      .where(eq(skills.name, "my-skill"))
      .get();
    expect(row?.body).toBe(UPDATED_BODY);
    expect(row?.description).toBe("Updated desc");
    expect(JSON.parse(row!.frontmatter)).toMatchObject({
      name: "my-skill",
      description: "Updated desc",
    });

    const onDisk = fs.readFileSync(
      path.join(homeRoot, "skills/my-skill/SKILL.md"),
      "utf-8",
    );
    expect(onDisk).toBe(UPDATED_BODY);

    expect(syncMock).toHaveBeenCalledTimes(1);
  });

  it("rejects when frontmatter name does not match params.name and leaves DB + disk unchanged", async () => {
    await addSkill({} as never, {
      name: "my-skill",
      description: "Original",
      body: ORIGINAL_BODY,
    });
    syncMock.mockClear();

    const res = await updateSkill({} as never, {
      name: "my-skill",
      body: MISMATCH_BODY,
    });
    expect(res.error).toMatch(/does not match/i);

    const row = getDb()
      .select()
      .from(skills)
      .where(eq(skills.name, "my-skill"))
      .get();
    expect(row?.body).toBe(ORIGINAL_BODY);
    expect(row?.description).toBe("Original");

    const onDisk = fs.readFileSync(
      path.join(homeRoot, "skills/my-skill/SKILL.md"),
      "utf-8",
    );
    expect(onDisk).toBe(ORIGINAL_BODY);

    expect(syncMock).not.toHaveBeenCalled();
  });

  it("rejects when params.name does not match frontmatter (param differs from body)", async () => {
    await addSkill({} as never, {
      name: "my-skill",
      description: "Original",
      body: ORIGINAL_BODY,
    });
    syncMock.mockClear();

    // body says my-skill but param says other-name
    const res = await updateSkill({} as never, {
      name: "other-name",
      body: ORIGINAL_BODY,
    });
    expect(res.error).toMatch(/does not match/i);
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("returns structured error when neither a user override nor a bundled skill exists", async () => {
    const res = await updateSkill({} as never, {
      name: "my-skill",
      body: UPDATED_BODY,
    });
    expect(res.error).toMatch(/no bundled skill named/i);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/no bundled skill named/i);
    expect(payload.data.name).toBe("my-skill");
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("creates a user override when updating a bundled skill, leaving the bundled row untouched", async () => {
    // A bundled row whose folder exists on disk (real repo mcp/skills/ai-asset-generation).
    getDb()
      .insert(skills)
      .values({
        id: "bundled-aag",
        name: "ai-asset-generation",
        description: "Bundled",
        source: "bundled",
        enabled: true,
        body: null,
        frontmatter: JSON.stringify({ name: "ai-asset-generation", description: "Bundled" }),
      })
      .run();
    syncMock.mockClear();

    const editedBody = `---\nname: ai-asset-generation\ndescription: My override\n---\nMy override body.\n`;
    const res = await updateSkill({} as never, {
      name: "ai-asset-generation",
      body: editedBody,
    });

    // New contract: success, and a user override row now shadows the bundled one.
    expect(res.error).toBeUndefined();
    const payload = JSON.parse(res.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.data.overrodeBundled).toBe(true);

    const userRow = getDb()
      .select()
      .from(skills)
      .where(and(eq(skills.name, "ai-asset-generation"), eq(skills.source, "user")))
      .get();
    expect(userRow).toBeTruthy();
    expect(userRow!.body).toContain("My override body.");
    expect(userRow!.forkedFromDigest).toMatch(/^[0-9a-f]{64}$/);

    // The bundled row is untouched.
    const bundledRow = getDb()
      .select()
      .from(skills)
      .where(eq(skills.id, "bundled-aag"))
      .get();
    expect(bundledRow!.description).toBe("Bundled");
    expect(bundledRow!.source).toBe("bundled");

    expect(syncMock).toHaveBeenCalled();
  });

  it("does not log the skill body content", async () => {
    await addSkill({} as never, {
      name: "my-skill",
      description: "Original",
      body: ORIGINAL_BODY,
    });

    const SECRET = "TOP_SECRET_BODY_CONTENT_xyz";
    const bodyWithSecret = `---\nname: my-skill\ndescription: secret\n---\n${SECRET}\n`;

    const infoSpy = vi.spyOn(mcpLogger, "info");
    try {
      await updateSkill({} as never, {
        name: "my-skill",
        body: bodyWithSecret,
      });
      for (const call of infoSpy.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(SECRET);
      }
      expect(infoSpy).toHaveBeenCalled();
      const firstArg = infoSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(firstArg.bodyLength).toBe(bodyWithSecret.length);
      expect(firstArg.name).toBe("my-skill");
    } finally {
      infoSpy.mockRestore();
    }
  });
});
