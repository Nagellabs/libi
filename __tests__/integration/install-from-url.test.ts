/**
 * Integration tests for the install-from-URL backend. Network is
 * stubbed — `fetchRepoTarball` returns a fixture directory baked
 * inline per test instead of hitting codeload.github.com.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { eq } from "drizzle-orm";

// IMPORTANT: mock BEFORE importing the SUT.
vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));
const invalidateMock = vi.fn();
vi.mock("@/lib/mcp-config", () => ({
  invalidateMcpConfig: (...args: unknown[]) => invalidateMock(...args),
}));
// syncSkillsToWorkspace touches the agent workspace; stub it for these tests.
vi.mock("@/mcp/skills/sync-workspace", () => ({
  syncSkillsToWorkspace: vi.fn().mockResolvedValue(undefined),
}));

import { getDb } from "@/lib/db/client";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { skills as skillsTable, mcpServers } from "@/lib/db/schema/sqlite";
import { installSingleSkill } from "@/lib/install-from-url/install-skill";
import { installClaudePlugin } from "@/lib/install-from-url/install-plugin";
import { SkillCollisionError } from "@/lib/install-from-url/types";
import { detectCandidate } from "@/lib/install-from-url/detect";

function skillMd(name: string, description = "Test skill"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`;
}

describe("install-from-url integration", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let fixtureRoot: string;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "libi-ifu-home-"));
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "libi-ifu-fixture-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = tmpHome;
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    invalidateMock.mockClear();
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("installs a single skill with supporting files and writes DB + disk", async () => {
    // Layout:
    //   fixtureRoot/SKILL.md
    //   fixtureRoot/scripts/helper.py    <-- supporting file
    await fs.writeFile(
      path.join(fixtureRoot, "SKILL.md"),
      skillMd("my-skill", "imported skill"),
    );
    await fs.mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
    const helperContent = "print('hello from helper')\n";
    await fs.writeFile(
      path.join(fixtureRoot, "scripts", "helper.py"),
      helperContent,
    );

    const result = await installSingleSkill({
      basePath: fixtureRoot,
      skillRelPath: ".",
      name: "my-skill",
    });
    expect(result).toEqual({ kind: "skill", name: "my-skill" });

    // DB row
    const rows = db
      .select()
      .from(skillsTable)
      .where(eq(skillsTable.name, "my-skill"))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("user");
    // Install-from-URL must NOT auto-enable the skill (RC-A defense-in-depth).
    expect(rows[0].enabled).toBe(false);
    expect(rows[0].description).toBe("imported skill");
    expect(rows[0].body).toContain("Body for my-skill.");

    // On-disk SKILL.md
    const installedSkillPath = path.join(tmpHome, "skills", "my-skill", "SKILL.md");
    const installedSkillContent = await fs.readFile(installedSkillPath, "utf-8");
    expect(installedSkillContent).toContain("Body for my-skill.");

    // Supporting file copied verbatim
    const installedHelperPath = path.join(
      tmpHome,
      "skills",
      "my-skill",
      "scripts",
      "helper.py",
    );
    const installedHelperContent = await fs.readFile(installedHelperPath, "utf-8");
    expect(installedHelperContent).toBe(helperContent);
  });

  it("throws SkillCollisionError when a user skill with the same name exists", async () => {
    // Pre-seed a user skill row
    db.insert(skillsTable)
      .values({
        id: "existing-id",
        name: "dup",
        description: "existing",
        source: "user",
        enabled: true,
        body: "existing body",
        frontmatter: "{}",
      })
      .run();

    await fs.writeFile(path.join(fixtureRoot, "SKILL.md"), skillMd("dup"));

    await expect(
      installSingleSkill({
        basePath: fixtureRoot,
        skillRelPath: ".",
        name: "dup",
      }),
    ).rejects.toBeInstanceOf(SkillCollisionError);

    // No new DB row was inserted (the original is still there alone).
    const rows = db
      .select()
      .from(skillsTable)
      .where(eq(skillsTable.name, "dup"))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("existing-id");
  });

  it("installs a claude plugin with 2 skills + 1 MCP and invalidates config", async () => {
    // Plugin layout:
    //   fixtureRoot/.claude-plugin/plugin.json
    //   fixtureRoot/skills/alpha/SKILL.md
    //   fixtureRoot/skills/beta/SKILL.md
    await fs.mkdir(path.join(fixtureRoot, ".claude-plugin"), { recursive: true });
    await fs.mkdir(path.join(fixtureRoot, "skills", "alpha"), { recursive: true });
    await fs.mkdir(path.join(fixtureRoot, "skills", "beta"), { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "skills", "alpha", "SKILL.md"),
      skillMd("alpha", "alpha desc"),
    );
    await fs.writeFile(
      path.join(fixtureRoot, "skills", "beta", "SKILL.md"),
      skillMd("beta", "beta desc"),
    );
    const manifest = {
      name: "test-plugin",
      version: "1.0.0",
      skills: ["skills/alpha", "skills/beta"],
      mcpServers: {
        "my-mcp": {
          command: "node",
          args: ["server.js"],
          env: { FOO: "bar" },
        },
      },
    };
    await fs.writeFile(
      path.join(fixtureRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify(manifest),
    );

    const detected = await detectCandidate(fixtureRoot);
    expect(detected.kind).toBe("claude-plugin");
    if (detected.kind !== "claude-plugin") throw new Error("unreachable");

    const result = await installClaudePlugin({
      basePath: fixtureRoot,
      manifest: detected.manifest,
    });

    expect(result.failed).toEqual([]);
    expect(result.installed.length).toBe(3);
    const skillNames = result.installed
      .filter((i) => i.kind === "skill")
      .map((i) => i.name)
      .sort();
    expect(skillNames).toEqual(["alpha", "beta"]);
    const mcpNames = result.installed.filter((i) => i.kind === "mcp").map((i) => i.name);
    expect(mcpNames).toEqual(["my-mcp"]);

    // DB: 2 skills landed
    expect(
      db.select().from(skillsTable).where(eq(skillsTable.name, "alpha")).all().length,
    ).toBe(1);
    expect(
      db.select().from(skillsTable).where(eq(skillsTable.name, "beta")).all().length,
    ).toBe(1);

    // DB: 1 MCP row landed with the right envVars JSON
    const mcpRows = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.name, "my-mcp"))
      .all();
    expect(mcpRows.length).toBe(1);
    const mcp = mcpRows[0];
    expect(mcp.type).toBe("stdio");
    expect(mcp.command).toBe("node");
    expect(mcp.args).toBe(JSON.stringify(["server.js"]));
    expect(mcp.envVars).toBe(JSON.stringify({ FOO: "bar" }));
    expect(mcp.installStatus).toBe("not_required");
    expect(mcp.bundled).toBe(false);
    expect(mcp.enabled).toBe(true);

    // On-disk skills exist
    await expect(
      fs.access(path.join(tmpHome, "skills", "alpha", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tmpHome, "skills", "beta", "SKILL.md")),
    ).resolves.toBeUndefined();

    // invalidateMcpConfig was called once (because >=1 MCP row added)
    expect(invalidateMock).toHaveBeenCalledTimes(1);
    expect(invalidateMock).toHaveBeenCalledWith({ reason: "install-from-url" });
  });

  it("renames MCP server on collision with existing row", async () => {
    // Pre-seed an MCP server with the same requested name
    db.insert(mcpServers)
      .values({
        id: "existing-mcp-id",
        name: "shared-name",
        type: "stdio",
        command: "echo",
        enabled: true,
        requireApproval: true,
        bundled: false,
        installStatus: "not_required",
      })
      .run();

    // Fixture: plugin with 0 skills, 1 MCP named "shared-name"
    await fs.mkdir(path.join(fixtureRoot, ".claude-plugin"), { recursive: true });
    const manifest = {
      name: "my-plugin",
      mcpServers: {
        "shared-name": { command: "node", args: ["s.js"] },
      },
    };
    await fs.writeFile(
      path.join(fixtureRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify(manifest),
    );
    const detected = await detectCandidate(fixtureRoot);
    if (detected.kind !== "claude-plugin") throw new Error("expected plugin");

    const result = await installClaudePlugin({
      basePath: fixtureRoot,
      manifest: detected.manifest,
    });

    expect(result.failed).toEqual([]);
    expect(result.installed.length).toBe(1);
    const installed = result.installed[0];
    expect(installed.kind).toBe("mcp");
    expect(installed.name).toBe("shared-name (from my-plugin)");
    expect(installed.note).toContain("renamed");

    // DB: original still exists, plus the renamed one
    const allRows = db.select().from(mcpServers).all();
    const names = allRows.map((r) => r.name).sort();
    expect(names).toEqual(["shared-name", "shared-name (from my-plugin)"]);
  });

  it("auto-discovers skills/*/SKILL.md when plugin manifest omits skills[]", async () => {
    // Real-world plugins (obra/superpowers etc.) don't list `skills[]`
    // because Claude Code auto-discovers them. Mirror that behavior.
    await fs.mkdir(path.join(fixtureRoot, ".claude-plugin"), { recursive: true });
    await fs.mkdir(path.join(fixtureRoot, "skills", "auto-one"), { recursive: true });
    await fs.mkdir(path.join(fixtureRoot, "skills", "auto-two"), { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "skills", "auto-one", "SKILL.md"),
      skillMd("auto-one", "auto one desc"),
    );
    await fs.writeFile(
      path.join(fixtureRoot, "skills", "auto-two", "SKILL.md"),
      skillMd("auto-two", "auto two desc"),
    );
    const manifest = { name: "plugin-no-skills-field", version: "1.0.0" };
    await fs.writeFile(
      path.join(fixtureRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify(manifest),
    );

    const detected = await detectCandidate(fixtureRoot);
    if (detected.kind !== "claude-plugin") throw new Error("expected plugin");

    const result = await installClaudePlugin({
      basePath: fixtureRoot,
      manifest: detected.manifest,
    });

    expect(result.failed).toEqual([]);
    const installedNames = result.installed
      .filter((i) => i.kind === "skill")
      .map((i) => i.name)
      .sort();
    expect(installedNames).toEqual(["auto-one", "auto-two"]);
  });
});
