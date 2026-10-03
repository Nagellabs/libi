import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Skill } from "@/mcp/skills/types";

const enabled: Skill[] = [];
vi.mock("@/mcp/skills/loader", () => ({ loadEnabledSkills: async () => enabled }));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: () => {} }));

import { migrateDatabase, resetDbClient } from "@/lib/db/client";
import { serverLogger } from "@/lib/logger";
import { addSkillInstall, removeSkillInstall, syncSkillInstalls } from "@/mcp/skills/installs";
import { managedSkillNames } from "@/mcp/skills/writer";

// A user-level root an older libi wrote (the manifest, no install row) must be brought up to date by
// the same sync that rewrites recorded installs — on boot and after a skill change — without ever
// touching a folder libi did not write.

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
const root = () => path.join(home, ".agents", "skills");

function plantOldMirror(): void {
  fs.mkdirSync(root(), { recursive: true });
  for (const n of ["ai-video-models", "speech-captions"]) {
    fs.mkdirSync(path.join(root(), n), { recursive: true });
    fs.writeFileSync(path.join(root(), n, "SKILL.md"), `---\nname: ${n}\n---\nold ${n} (libi.analysis_get_audio_chunks)\n`);
  }
  fs.mkdirSync(path.join(root(), "synced"), { recursive: true });
  fs.writeFileSync(path.join(root(), "synced", "notes.md"), "not libi's\n");
  fs.writeFileSync(path.join(root(), ".libi-managed.json"), JSON.stringify({ managed: ["ai-video-models", "speech-captions"] }) + "\n");
}

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "legacy-sync-")));
  home = path.join(scratch, "home");
  libiHome = path.join(home, ".libi");
  fs.mkdirSync(path.join(libiHome, "agent"), { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("LIBI_HOME", libiHome);
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  vi.stubEnv("LIBI_SHELL_ENV", undefined);
  vi.stubEnv("LIBI_MCP_SUPERVISED", undefined);
  vi.stubEnv("DB_PATH", path.join(scratch, "libi.sqlite"));
  resetDbClient();
  migrateDatabase(path.join(scratch, "libi.sqlite"));
  enabled.splice(0, enabled.length, skill("speech-captions", "current body"), skill("video-generation-craft"));
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDbClient();
  vi.unstubAllEnvs();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("syncSkillInstalls and a user root no row records", () => {
  it("drops the retired skill, rewrites the changed one, adds the new one, logs it, leaves the user's folder", async () => {
    plantOldMirror();
    const info = vi.spyOn(serverLogger, "info");

    await syncSkillInstalls("boot");

    expect(fs.existsSync(path.join(root(), "ai-video-models"))).toBe(false);
    expect(fs.readFileSync(path.join(root(), "speech-captions", "SKILL.md"), "utf-8")).toContain("current body");
    expect(fs.existsSync(path.join(root(), "video-generation-craft", "SKILL.md"))).toBe(true);
    expect(managedSkillNames(root())).toEqual(["speech-captions", "video-generation-craft"]);
    expect(fs.readFileSync(path.join(root(), "synced", "notes.md"), "utf-8")).toBe("not libi's\n");
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "skills", op: "legacy_user_roots_refreshed", reason: "boot", removed: 1, roots: 1 }),
      expect.any(String),
    );
  });

  it("does nothing from a throwaway LIBI_HOME outside the user's home", async () => {
    plantOldMirror();
    vi.stubEnv("LIBI_HOME", path.join(scratch, "tmp-libi-home"));
    await syncSkillInstalls("boot");
    expect(fs.existsSync(path.join(root(), "ai-video-models"))).toBe(true);
    expect(fs.readFileSync(path.join(root(), "speech-captions", "SKILL.md"), "utf-8")).toContain("old speech-captions");
  });

  it("does nothing when the user's root has no manifest", async () => {
    fs.mkdirSync(path.join(root(), "ai-video-models"), { recursive: true });
    fs.writeFileSync(path.join(root(), "ai-video-models", "SKILL.md"), "the user's own\n");
    await syncSkillInstalls("boot");
    expect(fs.readFileSync(path.join(root(), "ai-video-models", "SKILL.md"), "utf-8")).toBe("the user's own\n");
    expect(fs.existsSync(path.join(root(), "speech-captions"))).toBe(false);
  });

  it("leaves a recorded user-level install to its row: removing it removes the copy and nothing brings it back", async () => {
    plantOldMirror();
    await addSkillInstall({ agentId: "codex", scope: "user", source: "ui" });
    const view = (await import("@/mcp/skills/installs")).listSkillInstalls;
    const [row] = await view();
    expect(managedSkillNames(root())).toEqual(["speech-captions", "video-generation-craft"]);

    await removeSkillInstall(row.id);
    expect(fs.existsSync(path.join(root(), ".libi-managed.json"))).toBe(false);

    await syncSkillInstalls("boot");
    expect(fs.existsSync(path.join(root(), "speech-captions"))).toBe(false);
    expect(fs.readFileSync(path.join(root(), "synced", "notes.md"), "utf-8")).toBe("not libi's\n");
  });

  it("a second sync with nothing changed logs no refresh", async () => {
    plantOldMirror();
    await syncSkillInstalls("boot");
    const info = vi.spyOn(serverLogger, "info");
    await syncSkillInstalls("skills-changed");
    expect(info).not.toHaveBeenCalledWith(expect.objectContaining({ op: "legacy_user_roots_refreshed" }), expect.any(String));
  });
});
