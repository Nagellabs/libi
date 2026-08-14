/**
 * A hostile GitHub repo can ship a skill folder containing a symlink to a
 * file outside the extracted tarball (e.g. into the user's home directory).
 * `installSingleSkill` must refuse the whole install rather than dereference
 * it into `~/.libi/skills/...`, and must not leave a copy of the symlink's
 * target's bytes on disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// IMPORTANT: mock BEFORE importing the SUT — mirrors
// __tests__/integration/install-from-url.test.ts.
vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));
vi.mock("@/mcp/skills/sync-workspace", () => ({
  syncSkillsToWorkspace: vi.fn().mockResolvedValue(undefined),
}));

import { getDb } from "@/lib/db/client";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { installSingleSkill } from "@/lib/install-from-url/install-skill";

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: Test skill\n---\n\nBody for ${name}.\n`;
}

describe("installSingleSkill symlink guard", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let fixtureRoot: string;
  let secretDir: string;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "libi-symlink-home-"));
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "libi-symlink-fixture-"));
    secretDir = await fs.mkdtemp(path.join(os.tmpdir(), "libi-symlink-secret-"));
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
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    await fs.rm(secretDir, { recursive: true, force: true });
  });

  it("refuses to install a skill tree containing a symlink, and leaks nothing", async () => {
    const secretFile = path.join(secretDir, "id_rsa");
    await fs.writeFile(secretFile, "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n");

    await fs.writeFile(path.join(fixtureRoot, "SKILL.md"), skillMd("evil-skill"));
    await fs.mkdir(path.join(fixtureRoot, "prompts"), { recursive: true });
    const linkPath = path.join(fixtureRoot, "prompts", "leak.md");
    await fs.symlink(secretFile, linkPath);

    await expect(
      installSingleSkill({
        basePath: fixtureRoot,
        skillRelPath: ".",
        name: "evil-skill",
      }),
    ).rejects.toThrow(/symlink/i);

    // Nothing was ever materialized on disk under the skills dir — in
    // particular, the secret bytes were never copied anywhere.
    const installedDir = path.join(tmpHome, "skills", "evil-skill");
    await expect(fs.access(installedDir)).rejects.toThrow();
  });

  it("still installs a skill tree with no symlinks", async () => {
    await fs.writeFile(path.join(fixtureRoot, "SKILL.md"), skillMd("clean-skill"));
    await fs.mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
    await fs.writeFile(path.join(fixtureRoot, "scripts", "helper.py"), "print('hi')\n");

    const result = await installSingleSkill({
      basePath: fixtureRoot,
      skillRelPath: ".",
      name: "clean-skill",
    });
    expect(result).toEqual({ kind: "skill", name: "clean-skill" });

    const installedHelper = await fs.readFile(
      path.join(tmpHome, "skills", "clean-skill", "scripts", "helper.py"),
      "utf-8",
    );
    expect(installedHelper).toBe("print('hi')\n");
  });
});
