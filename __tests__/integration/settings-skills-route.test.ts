/**
 * Route test for POST /api/settings/skills — verifies that a user skill
 * created through the HTTP surface defaults to `enabled: false`
 * (RC-A defense-in-depth), and only enables when the request explicitly
 * passes `enabled: true`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/mcp/skills/sync-workspace", () => ({
  syncSkillsToWorkspace: vi.fn().mockResolvedValue(undefined),
}));

import { getDb } from "@/lib/db/client";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { skills as skillsTable } from "@/lib/db/schema/sqlite";
import { POST } from "@/app/api/settings/skills/route";

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: A test skill\n---\n\nBody for ${name}.\n`;
}

function req(payload: unknown): Request {
  return new Request("http://localhost/api/settings/skills", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

describe("POST /api/settings/skills", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "libi-skills-route-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = tmpHome;
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("defaults a newly created user skill to enabled=false", async () => {
    const res = await POST(req({ name: "alpha", description: "A test skill", body: skillMd("alpha") }));
    expect(res.status).toBe(201);
    const rows = db.select().from(skillsTable).where(eq(skillsTable.name, "alpha")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("user");
    expect(rows[0].enabled).toBe(false);
  });

  it("honors an explicit enabled=true", async () => {
    const res = await POST(
      req({ name: "beta", description: "A test skill", body: skillMd("beta"), enabled: true }),
    );
    expect(res.status).toBe(201);
    const rows = db.select().from(skillsTable).where(eq(skillsTable.name, "beta")).all();
    expect(rows[0].enabled).toBe(true);
  });
});
