/**
 * End-to-end mirror integration test.
 *
 * Verifies that the FLAT, self-contained workspace mirror produced by
 * syncSkillsToWorkspace() is written correctly to the agent directory when
 * skills are added, extended with prompt files, and disabled.
 *
 * Key invariants:
 *   - .claude/skills/<name>/SKILL.md and .agents/skills/<name>/SKILL.md are written
 *   - prompts/ subdirectory is mirrored flat inside each skill dir
 *   - Only subdirectory allowed inside a skill dir is "prompts/" (flat mirror, no nesting)
 *   - Disabling a skill removes its dir from both dialects
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { addSkill, addSkillPrompt, setSkillEnabled } from "@/mcp/tools/skill-tools";
import { getLibiAgentDir } from "@/lib/libi-home";

const DEMO_BODY = `---\nname: demo\ndescription: d\n---\nUse prompts/hook.md\n`;

describe("skills workspace mirror (e2e)", () => {
  let homeRoot: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-mirror-e2e-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = homeRoot;
    createTestDb();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    resetTestDb();
    fs.rmSync(homeRoot, { recursive: true, force: true });
  });

  it("mirrors a user skill + its prompt flat into .claude/skills and .agents/skills", async () => {
    // 1. Add user skill — triggers syncSkillsToWorkspace()
    await addSkill({} as never, { name: "demo", description: "d", body: DEMO_BODY });

    // 2. Add a prompt file — triggers syncSkillsToWorkspace() again
    const addRes = await addSkillPrompt({} as never, {
      skillName: "demo",
      name: "hook",
      body: "# Hook",
    });
    expect(addRes.error).toBeUndefined();

    const agentDir = getLibiAgentDir();
    const claude = path.join(agentDir, ".claude", "skills", "demo");
    const codex = path.join(agentDir, ".agents", "skills", "demo");

    // SKILL.md is present in both dialects
    expect(fs.existsSync(path.join(claude, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(codex, "SKILL.md"))).toBe(true);

    // prompt file is present under prompts/ in both dialects
    expect(fs.existsSync(path.join(claude, "prompts", "hook.md"))).toBe(true);
    expect(fs.readFileSync(path.join(claude, "prompts", "hook.md"), "utf-8")).toBe("# Hook");
    expect(fs.existsSync(path.join(codex, "prompts", "hook.md"))).toBe(true);
    expect(fs.readFileSync(path.join(codex, "prompts", "hook.md"), "utf-8")).toBe("# Hook");

    // Flat invariant: the only subdirectory allowed inside each skill dir is "prompts/"
    for (const dialectRoot of [
      path.join(agentDir, ".claude", "skills"),
      path.join(agentDir, ".agents", "skills"),
    ]) {
      const roots = fs
        .readdirSync(dialectRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory());
      for (const r of roots) {
        const inner = fs
          .readdirSync(path.join(dialectRoot, r.name), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
        // every subdirectory inside a skill dir must be "prompts"
        expect(inner.every((d) => d === "prompts")).toBe(true);
      }
    }
  });

  it("disabling a skill removes its bundle from the mirror", async () => {
    // 1. Add skill + prompt so the mirror has content
    const addRes = await addSkill({} as never, {
      name: "demo",
      description: "d",
      body: DEMO_BODY,
    });
    const data = JSON.parse(addRes.content[0].text);
    const skillId: string = data.id;

    await addSkillPrompt({} as never, { skillName: "demo", name: "hook", body: "# Hook" });

    const agentDir = getLibiAgentDir();
    const claudeSkillDir = path.join(agentDir, ".claude", "skills", "demo");
    const codexSkillDir = path.join(agentDir, ".agents", "skills", "demo");

    // Confirm both dirs are present before disabling
    expect(fs.existsSync(claudeSkillDir)).toBe(true);
    expect(fs.existsSync(codexSkillDir)).toBe(true);

    // 2. Disable the skill — triggers syncSkillsToWorkspace()
    await setSkillEnabled({} as never, { id: skillId, enabled: false });

    // Both skill dirs should be gone
    expect(fs.existsSync(claudeSkillDir)).toBe(false);
    expect(fs.existsSync(codexSkillDir)).toBe(false);
  });
});
