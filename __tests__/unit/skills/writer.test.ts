import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeSkillsToWorkspace } from "@/mcp/skills/writer";
import type { Skill } from "@/mcp/skills/types";

const FOO: Skill = {
  id: "foo",
  name: "foo",
  description: "Foo skill",
  source: "bundled",
  enabled: true,
  body: `---\nname: foo\ndescription: Foo skill\n---\nFoo body\n`,
  frontmatter: { name: "foo", description: "Foo skill" },
  supportingFiles: [{ relPath: "templates/x.md", contents: "X content" }],
  tags: [],
};

function makeSkill(name: string): Skill {
  return {
    id: name,
    name,
    description: `${name} skill`,
    source: "bundled",
    enabled: true,
    body: `---\nname: ${name}\ndescription: ${name} skill\n---\n${name} body\n`,
    frontmatter: { name, description: `${name} skill` },
    supportingFiles: [],
    tags: [],
  };
}

describe("writeSkillsToWorkspace", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("writes SKILL.md and supporting files to .claude and .agents (flat)", async () => {
    await writeSkillsToWorkspace(workspace, [FOO]);
    expect(fs.readFileSync(path.join(workspace, ".claude/skills/foo/SKILL.md"), "utf-8")).toContain("Foo body");
    expect(fs.readFileSync(path.join(workspace, ".claude/skills/foo/templates/x.md"), "utf-8")).toBe("X content");
    expect(fs.readFileSync(path.join(workspace, ".agents/skills/foo/SKILL.md"), "utf-8")).toContain("Foo body");
    expect(fs.readFileSync(path.join(workspace, ".agents/skills/foo/templates/x.md"), "utf-8")).toBe("X content");
  });

  it("no longer writes to .codex/skills (codex discovers via .agents/skills)", async () => {
    await writeSkillsToWorkspace(workspace, [FOO]);
    expect(fs.existsSync(path.join(workspace, ".codex/skills/foo"))).toBe(false);
  });

  it("does not create a GEMINI.md (inlining retired)", async () => {
    await writeSkillsToWorkspace(workspace, [FOO]);
    expect(fs.existsSync(path.join(workspace, "GEMINI.md"))).toBe(false);
  });

  it("sweeps a libi-generated GEMINI.md (contains the ownership marker)", async () => {
    const geminiPath = path.join(workspace, "GEMINI.md");
    fs.writeFileSync(
      geminiPath,
      "some preamble\n<!-- libi-skills-start -->\n## Skills\n### old\n<!-- libi-skills-end -->\n",
    );
    await writeSkillsToWorkspace(workspace, [FOO]);
    expect(fs.existsSync(geminiPath)).toBe(false);
  });

  it("leaves a user-authored GEMINI.md WITHOUT the marker intact", async () => {
    const geminiPath = path.join(workspace, "GEMINI.md");
    fs.writeFileSync(geminiPath, "# My custom GEMINI prompt\n\nKeep this paragraph.\n");
    await writeSkillsToWorkspace(workspace, [FOO]);
    expect(fs.existsSync(geminiPath)).toBe(true);
    expect(fs.readFileSync(geminiPath, "utf-8")).toContain("Keep this paragraph.");
  });

  it("is idempotent — re-running with same skills does not change file mtimes", async () => {
    await writeSkillsToWorkspace(workspace, [FOO]);
    const stat1 = fs.statSync(path.join(workspace, ".claude/skills/foo/SKILL.md"));
    await new Promise((r) => setTimeout(r, 50));
    await writeSkillsToWorkspace(workspace, [FOO]);
    const stat2 = fs.statSync(path.join(workspace, ".claude/skills/foo/SKILL.md"));
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
  });

  it("removes orphaned skill directories from previous runs", async () => {
    await writeSkillsToWorkspace(workspace, [FOO]);
    expect(fs.existsSync(path.join(workspace, ".claude/skills/foo"))).toBe(true);
    await writeSkillsToWorkspace(workspace, []);
    expect(fs.existsSync(path.join(workspace, ".claude/skills/foo"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".agents/skills/foo"))).toBe(false);
  });

  it("handles supporting file removal across runs", async () => {
    await writeSkillsToWorkspace(workspace, [FOO]);
    expect(fs.existsSync(path.join(workspace, ".claude/skills/foo/templates/x.md"))).toBe(true);
    const FOO_SLIM = { ...FOO, supportingFiles: [] };
    await writeSkillsToWorkspace(workspace, [FOO_SLIM]);
    expect(fs.existsSync(path.join(workspace, ".claude/skills/foo/templates/x.md"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".claude/skills/foo/SKILL.md"))).toBe(true);
  });

  it("prunes empty supporting-file directories after orphan removal", async () => {
    const FOO_NESTED = {
      ...FOO,
      supportingFiles: [{ relPath: "templates/x.md", contents: "X" }],
    };
    await writeSkillsToWorkspace(workspace, [FOO_NESTED]);
    expect(fs.existsSync(path.join(workspace, ".claude/skills/foo/templates/x.md"))).toBe(true);

    // Re-run with the supporting file removed entirely
    const FOO_SLIM = { ...FOO, supportingFiles: [] };
    await writeSkillsToWorkspace(workspace, [FOO_SLIM]);
    expect(fs.existsSync(path.join(workspace, ".claude/skills/foo/templates"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".claude/skills/foo/SKILL.md"))).toBe(true);
  });
});

describe("skills mirror ownership manifest", () => {
  let wsManifest: string;
  // The DEFAULT-agent-dir case below resolves getLibiAgentDir(), which derives
  // from LIBI_HOME. The global setup points that at ONE temp dir shared by the
  // whole run, and four test files write into `<LIBI_HOME>/agent/` — in
  // parallel worker PROCESSES, against the same directory on disk. Since
  // writeSkillsToWorkspace DELETES every non-enabled dir it finds there, that
  // is shared mutable state two workers can interleave on. Give this file its
  // own LIBI_HOME so the default dir is private to it. The global setup
  // explicitly blesses this override.
  let ownHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    wsManifest = fs.mkdtempSync(path.join(os.tmpdir(), "ws-manifest-"));
    ownHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-home-writer-"));
    fs.mkdirSync(path.join(ownHome, "agent"), { recursive: true });
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = ownHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    fs.rmSync(wsManifest, { recursive: true, force: true });
    fs.rmSync(ownHome, { recursive: true, force: true });
  });

  it("never deletes a user-owned skill dir in a non-default workspace", async () => {
    const userSkill = path.join(wsManifest, ".claude", "skills", "my-own-skill");
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, "SKILL.md"), "# mine");

    await writeSkillsToWorkspace(wsManifest, [makeSkill("libi-skill")]);

    expect(fs.existsSync(path.join(userSkill, "SKILL.md"))).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(wsManifest, ".claude", "skills", ".libi-managed.json"),
        "utf-8",
      ),
    );
    expect(manifest.managed).toEqual(["libi-skill"]);
  });

  it("removes a manifest-listed skill that is no longer enabled", async () => {
    await writeSkillsToWorkspace(wsManifest, [makeSkill("old-skill")]);
    await writeSkillsToWorkspace(wsManifest, [makeSkill("new-skill")]);

    const root = path.join(wsManifest, ".claude", "skills");
    expect(fs.existsSync(path.join(root, "old-skill"))).toBe(false);
    expect(fs.existsSync(path.join(root, "new-skill"))).toBe(true);
  });

  it("grandfathers the DEFAULT agent dir without a manifest (cleans all non-enabled)", async () => {
    const { getLibiAgentDir } = await import("@/lib/libi-home");
    const defaultDir = getLibiAgentDir();
    const stray = path.join(defaultDir, ".claude", "skills", "stale-old-skill");
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, "SKILL.md"), "stale");

    await writeSkillsToWorkspace(defaultDir, [makeSkill("libi-skill")]);

    expect(fs.existsSync(stray)).toBe(false);
    // No manual cleanup needed any more: the whole LIBI_HOME this test used is
    // private to it and removed in afterEach.
  });
});

describe("legacy .codex/skills sweep", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-codex-sweep-"));
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("removes manifest-listed skill dirs and the manifest from a legacy .codex/skills", async () => {
    const codexRoot = path.join(ws, ".codex", "skills");
    const oldSkill = path.join(codexRoot, "libi-old");
    fs.mkdirSync(oldSkill, { recursive: true });
    fs.writeFileSync(path.join(oldSkill, "SKILL.md"), "old");
    fs.writeFileSync(
      path.join(codexRoot, ".libi-managed.json"),
      JSON.stringify({ managed: ["libi-old"] }, null, 2) + "\n",
    );

    await writeSkillsToWorkspace(ws, [makeSkill("foo")]);

    // The whole legacy dir ends up empty → removed.
    expect(fs.existsSync(codexRoot)).toBe(false);
    // And the new codex discovery path got the skill instead.
    expect(fs.existsSync(path.join(ws, ".agents", "skills", "foo", "SKILL.md"))).toBe(true);
  });

  it("preserves a user's own (non-manifest) dir inside legacy .codex/skills", async () => {
    const codexRoot = path.join(ws, ".codex", "skills");
    const libiSkill = path.join(codexRoot, "libi-old");
    const userSkill = path.join(codexRoot, "my-own");
    fs.mkdirSync(libiSkill, { recursive: true });
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(libiSkill, "SKILL.md"), "old");
    fs.writeFileSync(path.join(userSkill, "SKILL.md"), "# mine");
    fs.writeFileSync(
      path.join(codexRoot, ".libi-managed.json"),
      JSON.stringify({ managed: ["libi-old"] }, null, 2) + "\n",
    );

    await writeSkillsToWorkspace(ws, [makeSkill("foo")]);

    // libi-owned dir + manifest gone; user's own dir survives.
    expect(fs.existsSync(libiSkill)).toBe(false);
    expect(fs.existsSync(path.join(codexRoot, ".libi-managed.json"))).toBe(false);
    expect(fs.readFileSync(path.join(userSkill, "SKILL.md"), "utf-8")).toBe("# mine");
  });

  it("no-ops when there is no legacy .codex/skills dir", async () => {
    await expect(writeSkillsToWorkspace(ws, [makeSkill("foo")])).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(ws, ".codex"))).toBe(false);
  });
});
