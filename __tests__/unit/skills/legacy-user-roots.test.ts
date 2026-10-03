import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Skill } from "@/mcp/skills/types";
import {
  homeMayRefreshUserRoots,
  legacyUserRoots,
  refreshLegacyUserRoots,
  type LegacyRootsOptions,
} from "@/mcp/skills/legacy-user-roots";
import { managedSkillNames } from "@/mcp/skills/writer";
import { serverLogger } from "@/lib/logger";

function skill(name: string, text = `${name} body`): Skill {
  return {
    id: name, name, description: `${name} skill`, source: "bundled", enabled: true,
    body: `---\nname: ${name}\ndescription: ${name} skill\n---\n${text}\n`,
    frontmatter: { name, description: `${name} skill` }, supportingFiles: [], tags: [],
  };
}

let scratch: string;
let home: string;
let libiHome: string;

function opts(over: Partial<LegacyRootsOptions> = {}): LegacyRootsOptions {
  return { recordedAgents: new Set(), env: {} as NodeJS.ProcessEnv, homedir: home, libiHome, linkedToLibiAgentDir: () => false, ...over };
}

/** A root as an older libi left it: skill folders plus `.libi-managed.json` listing them. */
function plantMirror(root: string, names: string[], body = (n: string) => `old ${n}`): void {
  fs.mkdirSync(root, { recursive: true });
  for (const n of names) {
    fs.mkdirSync(path.join(root, n), { recursive: true });
    fs.writeFileSync(path.join(root, n, "SKILL.md"), `---\nname: ${n}\n---\n${body(n)}\n`);
  }
  fs.writeFileSync(path.join(root, ".libi-managed.json"), JSON.stringify({ managed: names }, null, 2) + "\n");
}

const codexRoot = () => path.join(home, ".agents", "skills");
const claudeRoot = () => path.join(home, ".claude", "skills");
const text = (root: string, name: string) => fs.readFileSync(path.join(root, name, "SKILL.md"), "utf-8");

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "legacy-roots-")));
  home = path.join(scratch, "home");
  libiHome = path.join(home, ".libi");
  fs.mkdirSync(libiHome, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("homeMayRefreshUserRoots", () => {
  it("allows a home inside the user's home, never a throwaway or a worktree home", () => {
    expect(homeMayRefreshUserRoots(path.join(home, ".libi"), home)).toBe(true);
    expect(homeMayRefreshUserRoots(path.join(home, "Library", "Application Support", "libi"), home)).toBe(true);
    // vitest and skill-eval homes live in the OS temp dir, outside the user's home
    expect(homeMayRefreshUserRoots(path.join(scratch, "libi-vitest-abc"), home)).toBe(false);
    // a dev worktree's skills may be older or newer than the installed libi's
    expect(homeMayRefreshUserRoots(path.join(home, ".libi", "worktrees", "agent-speed"), home)).toBe(false);
  });
});

describe("legacyUserRoots", () => {
  it("finds an agent's user root that holds libi's manifest and a listed folder", () => {
    plantMirror(codexRoot(), ["speech-captions"]);
    expect(legacyUserRoots(opts())).toEqual([{ agentId: "codex", root: codexRoot() }]);
  });

  it("ignores a root with no manifest: those folders are the user's", () => {
    fs.mkdirSync(path.join(codexRoot(), "my-skill"), { recursive: true });
    expect(legacyUserRoots(opts())).toEqual([]);
  });

  it("ignores a manifest whose listed folders are all gone (the user deleted them by hand)", () => {
    plantMirror(codexRoot(), ["speech-captions"]);
    fs.rmSync(path.join(codexRoot(), "speech-captions"), { recursive: true });
    expect(legacyUserRoots(opts())).toEqual([]);
  });

  it("ignores an unreadable manifest", () => {
    plantMirror(codexRoot(), ["speech-captions"]);
    fs.writeFileSync(path.join(codexRoot(), ".libi-managed.json"), "{not json");
    expect(legacyUserRoots(opts())).toEqual([]);
  });

  it("leaves an agent with a recorded user-level install to that install", () => {
    plantMirror(codexRoot(), ["speech-captions"]);
    expect(legacyUserRoots(opts({ recordedAgents: new Set(["codex"]) }))).toEqual([]);
  });

  it("never goes through a linked root", () => {
    const elsewhere = path.join(scratch, "dotfiles-skills");
    plantMirror(elsewhere, ["speech-captions"]);
    fs.mkdirSync(path.dirname(codexRoot()), { recursive: true });
    fs.symlinkSync(elsewhere, codexRoot());
    expect(legacyUserRoots(opts())).toEqual([]);
  });

  it("skips a root that is libi's own agent dir", () => {
    plantMirror(codexRoot(), ["speech-captions"]);
    expect(legacyUserRoots(opts({ linkedToLibiAgentDir: () => true }))).toEqual([]);
  });

  it("does nothing from a throwaway home", () => {
    plantMirror(codexRoot(), ["speech-captions"]);
    expect(legacyUserRoots(opts({ libiHome: path.join(scratch, "tmp-home") }))).toEqual([]);
  });

  it("reads Claude's root from CLAUDE_CONFIG_DIR", () => {
    const configDir = path.join(home, "claude-config");
    plantMirror(path.join(configDir, "skills"), ["speech-captions"]);
    expect(legacyUserRoots(opts({ env: { CLAUDE_CONFIG_DIR: configDir } as unknown as NodeJS.ProcessEnv }))).toEqual([
      { agentId: "claude-code", root: path.join(configDir, "skills") },
    ]);
  });
});

describe("refreshLegacyUserRoots", () => {
  it("removes a retired skill, rewrites a changed one, adds a new one, and keeps the user's own folder", () => {
    plantMirror(codexRoot(), ["ai-video-models", "speech-captions"]);
    fs.mkdirSync(path.join(codexRoot(), "my-own"), { recursive: true });
    fs.writeFileSync(path.join(codexRoot(), "my-own", "SKILL.md"), "mine\n");
    const info = vi.spyOn(serverLogger, "info");

    const result = refreshLegacyUserRoots(
      [skill("speech-captions", "new body"), skill("video-generation-craft")],
      legacyUserRoots(opts()),
      "boot",
    );

    expect(result).toMatchObject({ roots: 1, failed: 0, removed: 1 });
    expect(fs.existsSync(path.join(codexRoot(), "ai-video-models"))).toBe(false);
    expect(text(codexRoot(), "speech-captions")).toContain("new body");
    expect(text(codexRoot(), "video-generation-craft")).toContain("video-generation-craft body");
    expect(fs.readFileSync(path.join(codexRoot(), "my-own", "SKILL.md"), "utf-8")).toBe("mine\n");
    expect(managedSkillNames(codexRoot())).toEqual(["speech-captions", "video-generation-craft"]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "skills", op: "legacy_user_roots_refreshed", reason: "boot", removed: 1 }),
      expect.any(String),
    );
  });

  it("skips a bundled skill whose name the user already has, and does not claim it", () => {
    plantMirror(codexRoot(), ["speech-captions"]);
    fs.mkdirSync(path.join(codexRoot(), "video-generation-craft"), { recursive: true });
    fs.writeFileSync(path.join(codexRoot(), "video-generation-craft", "SKILL.md"), "the user's own\n");

    const result = refreshLegacyUserRoots([skill("speech-captions"), skill("video-generation-craft")], legacyUserRoots(opts()), "boot");

    expect(result.skipped).toBe(1);
    expect(fs.readFileSync(path.join(codexRoot(), "video-generation-craft", "SKILL.md"), "utf-8")).toBe("the user's own\n");
    expect(managedSkillNames(codexRoot())).not.toContain("video-generation-craft");
  });

  it("does not remove a listed name that is now a link, or touch what it points at", () => {
    plantMirror(codexRoot(), ["speech-captions", "ai-video-models"]);
    const target = path.join(scratch, "elsewhere");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep.txt"), "keep\n");
    fs.rmSync(path.join(codexRoot(), "ai-video-models"), { recursive: true });
    fs.symlinkSync(target, path.join(codexRoot(), "ai-video-models"));

    refreshLegacyUserRoots([skill("speech-captions")], legacyUserRoots(opts()), "boot");

    expect(fs.readFileSync(path.join(target, "keep.txt"), "utf-8")).toBe("keep\n");
    expect(fs.lstatSync(path.join(codexRoot(), "ai-video-models")).isSymbolicLink()).toBe(true);
    expect(managedSkillNames(codexRoot())).toEqual(["speech-captions"]);
  });

  it("is silent and writes nothing when the mirror is already current", () => {
    plantMirror(codexRoot(), ["speech-captions"]);
    refreshLegacyUserRoots([skill("speech-captions")], legacyUserRoots(opts()), "boot");
    const info = vi.spyOn(serverLogger, "info");
    const again = refreshLegacyUserRoots([skill("speech-captions")], legacyUserRoots(opts()), "skills-changed");
    expect(again).toMatchObject({ writes: 0, removed: 0, failed: 0 });
    expect(info).not.toHaveBeenCalled();
  });

  it("logs a failure and leaves going, without throwing", () => {
    plantMirror(codexRoot(), ["speech-captions"]);
    const warn = vi.spyOn(serverLogger, "warn");
    const roots = legacyUserRoots(opts());
    fs.writeFileSync(path.join(codexRoot(), ".libi-managed.json"), "{not json");
    const result = refreshLegacyUserRoots([skill("speech-captions")], roots, "boot");
    expect(result.failed).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "skills", op: "legacy_user_root_failed", agentId: "codex" }),
      expect.any(String),
    );
  });

  it("refreshes both agents' roots", () => {
    plantMirror(codexRoot(), ["ai-video-models"]);
    plantMirror(claudeRoot(), ["ai-video-models"]);
    const result = refreshLegacyUserRoots([skill("video-generation-craft")], legacyUserRoots(opts()), "boot");
    expect(result.roots).toBe(2);
    expect(managedSkillNames(codexRoot())).toEqual(["video-generation-craft"]);
    expect(managedSkillNames(claudeRoot())).toEqual(["video-generation-craft"]);
  });
});
