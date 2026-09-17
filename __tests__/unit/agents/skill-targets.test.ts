import { describe, it, expect } from "vitest";
import path from "node:path";
import { AGENT_SKILL_TARGETS, displayUserSkillsDir, skillTargetFor } from "@/lib/agents/skill-targets";
import { INSTALL_FOLDER_MESSAGES, USER_LEVEL_INSTALLED_MESSAGE } from "@/lib/agents/skill-installs-types";

const HOME = path.resolve(path.sep, "Users", "me");

describe("agent skill targets", () => {
  it("declares Claude Code and Codex with their project dialects", () => {
    expect(AGENT_SKILL_TARGETS.map((t) => [t.agentId, t.projectDialect])).toEqual([
      ["claude-code", ".claude/skills"],
      ["codex", ".agents/skills"],
    ]);
    expect(skillTargetFor("claude-code").name).toBe("Claude Code");
    expect(skillTargetFor("codex").name).toBe("Codex");
    expect(() => skillTargetFor("gemini" as never)).toThrow(/no skill target/);
  });

  it("Claude Code's user dir is <CLAUDE_CONFIG_DIR>/skills when set, else ~/.claude/skills", () => {
    const claude = skillTargetFor("claude-code");
    expect(claude.userSkillsDir({} as NodeJS.ProcessEnv, HOME)).toBe(path.join(HOME, ".claude", "skills"));
    expect(claude.userSkillsDir({ CLAUDE_CONFIG_DIR: "/cfg/claude" } as unknown as NodeJS.ProcessEnv, HOME)).toBe(path.resolve("/cfg/claude", "skills"));
    // An empty variable is unset, as the CLI treats it.
    expect(claude.userSkillsDir({ CLAUDE_CONFIG_DIR: "  " } as unknown as NodeJS.ProcessEnv, HOME)).toBe(path.join(HOME, ".claude", "skills"));
    expect(claude.userSkillsDisplay).toBe("~/.claude/skills");
  });

  it("a relative CLAUDE_CONFIG_DIR resolves against the home dir, never the cwd, so every libi process lands on the same root", () => {
    const claude = skillTargetFor("claude-code");
    const env = { CLAUDE_CONFIG_DIR: "rel/cfg" } as unknown as NodeJS.ProcessEnv;
    const dir = claude.userSkillsDir(env, HOME);
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(path.join(HOME, "rel", "cfg", "skills"));
    expect(displayUserSkillsDir(claude, env, HOME)).toBe("~/rel/cfg/skills");
  });

  it("Codex's user dir is always $HOME/.agents/skills, whatever CODEX_HOME says", () => {
    const codex = skillTargetFor("codex");
    expect(codex.userSkillsDir({ CODEX_HOME: "/elsewhere" } as unknown as NodeJS.ProcessEnv, HOME)).toBe(path.join(HOME, ".agents", "skills"));
    expect(codex.userSkillsDisplay).toBe("~/.agents/skills");
  });

  it("display text follows the resolved path: ~ under home, the full path elsewhere", () => {
    const claude = skillTargetFor("claude-code");
    expect(displayUserSkillsDir(claude, {} as NodeJS.ProcessEnv, HOME)).toBe("~/.claude/skills");
    expect(displayUserSkillsDir(claude, { CLAUDE_CONFIG_DIR: "/cfg/claude" } as unknown as NodeJS.ProcessEnv, HOME)).toBe(path.resolve("/cfg/claude", "skills"));
    expect(displayUserSkillsDir(skillTargetFor("codex"), {} as NodeJS.ProcessEnv, HOME)).toBe("~/.agents/skills");
  });

  it("carries one user-facing message per folder validation code", () => {
    expect(Object.keys(INSTALL_FOLDER_MESSAGES).sort()).toEqual(
      ["not_absolute", "not_directory", "not_found", "not_writable", "refused_home", "refused_libi_home", "refused_root"],
    );
    expect(USER_LEVEL_INSTALLED_MESSAGE).toBe("Skills are installed for every folder, so every folder already has them.");
  });
});
