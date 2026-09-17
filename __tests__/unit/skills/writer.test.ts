import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  writeSkillsToWorkspace,
  writeSkillsToRoot,
  removeSkillsFromRoot,
  managedSkillNames,
  sweepLegacyDialect,
  SKILL_DIALECTS,
  supportingFileKey,
  supportingFilePath,
  isSameOrInsidePath,
} from "@/mcp/skills/writer";
import type { Skill } from "@/mcp/skills/types";
import { serverLogger } from "@/lib/logger";

// Every `node:fs` export stays its real implementation, but is a spy the tests
// below can re-point — the writer imports this same mocked module.
vi.mock("node:fs", { spy: true });

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

/** What a user sees for an external root whose manifest cannot be read, on a write. Deleting
 *  only the manifest would leave libi's folders looking like the user's, so it names both. */
const UNREADABLE_MESSAGE =
  "libi's skills manifest (.libi-managed.json) is unreadable — delete it and libi's skill folders to reinstall them.";
/** Same, but for a removal — wording a Remove press shouldn't read as "reinstall". */
const UNREADABLE_REMOVE_MESSAGE =
  "libi's skills manifest (.libi-managed.json) is unreadable — delete it and libi's skill folders to remove them.";

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

  it("libi's own agent dir drops a dialect left out of `dialects` and restores it when listed again", async () => {
    const { getLibiAgentDir } = await import("@/lib/libi-home");
    const defaultDir = getLibiAgentDir();
    expect(defaultDir.startsWith(ownHome)).toBe(true);

    await writeSkillsToWorkspace(defaultDir, [FOO]);
    expect(fs.existsSync(path.join(defaultDir, ".claude/skills/foo/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(defaultDir, ".agents/skills/foo/SKILL.md"))).toBe(true);

    await writeSkillsToWorkspace(defaultDir, [FOO], { dialects: [".agents/skills"] });
    expect(fs.existsSync(path.join(defaultDir, ".claude/skills/foo"))).toBe(false);
    expect(fs.existsSync(path.join(defaultDir, ".agents/skills/foo/SKILL.md"))).toBe(true);

    await writeSkillsToWorkspace(defaultDir, [FOO], { dialects: SKILL_DIALECTS });
    expect(fs.readFileSync(path.join(defaultDir, ".claude/skills/foo/SKILL.md"), "utf-8")).toContain("Foo body");
    expect(fs.existsSync(path.join(defaultDir, ".agents/skills/foo/SKILL.md"))).toBe(true);
  });

  it("libi's own agent dir drops a dialect through a linked skills dir too, keeping the link itself", async () => {
    const { getLibiAgentDir } = await import("@/lib/libi-home");
    const defaultDir = getLibiAgentDir();

    // A dotfiles setup: the user shares libi's Codex skill files with their own tooling by
    // symlinking `<agent dir>/.agents/skills` to somewhere of their own.
    const linkedTarget = path.join(ownHome, "my-skills");
    fs.mkdirSync(linkedTarget, { recursive: true });
    fs.mkdirSync(path.join(defaultDir, ".agents"), { recursive: true });
    fs.symlinkSync(linkedTarget, path.join(defaultDir, ".agents", "skills"), "dir");

    await writeSkillsToWorkspace(defaultDir, [FOO]);
    expect(fs.existsSync(path.join(linkedTarget, "foo", "SKILL.md"))).toBe(true);

    // Dropping the codex dialect (e.g. Every folder for Codex records a user-level install)
    // must remove libi's copy at the link's target too, not just leave it doubled up. The
    // target is not an agent's user-level skills dir, so the protection below does not apply.
    const userRoot = path.join(ownHome, "user-home", ".agents", "skills");
    fs.mkdirSync(userRoot, { recursive: true });
    await writeSkillsToWorkspace(defaultDir, [FOO], { dialects: [".claude/skills"], protectedRoots: [userRoot] });
    expect(fs.existsSync(path.join(linkedTarget, "foo"))).toBe(false);
    expect(fs.lstatSync(path.join(defaultDir, ".agents", "skills")).isSymbolicLink()).toBe(true);
  });

  describe("libi's own agent dir never removes libi's skills from an agent's user-level skills dir", () => {
    const linkedLogs = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter((c) => (c[0] as { op?: string } | undefined)?.op === "own_agent_dir_linked_to_user_skills");

    /** The user-level install's copy, as the install service writes it. */
    const writeUserLevel = (root: string) => writeSkillsToRoot(root, [FOO], { external: true });

    it("a dropped dialect whose root links to a user-level skills dir (or inside one, or through a linked parent) removes nothing, on every later write too, and says so once", async () => {
      const { getLibiAgentDir } = await import("@/lib/libi-home");
      const defaultDir = getLibiAgentDir();
      // A separate home per case, so each one's link target is new to the once-only log.
      const cases: Array<[label: string, userHome: string, link: (userRoot: string, userHome: string) => void, holds: (userRoot: string) => string]> = [
        [
          "the root links to the user-level dir",
          path.join(ownHome, "user-home-same"),
          (userRoot) => fs.symlinkSync(userRoot, path.join(defaultDir, ".agents", "skills"), "dir"),
          (userRoot) => userRoot,
        ],
        [
          "the root links inside the user-level dir",
          path.join(ownHome, "user-home-inside"),
          (userRoot) => fs.symlinkSync(path.join(userRoot, "nested"), path.join(defaultDir, ".agents", "skills"), "dir"),
          (userRoot) => path.join(userRoot, "nested"),
        ],
        [
          "the root's parent links to the user-level dir's parent",
          path.join(ownHome, "user-home-parent"),
          (_userRoot, userHome) => {
            fs.rmSync(path.join(defaultDir, ".agents"), { recursive: true, force: true });
            fs.symlinkSync(path.join(userHome, ".agents"), path.join(defaultDir, ".agents"), "dir");
          },
          (userRoot) => userRoot,
        ],
      ];
      for (const [label, userHome, linkIt, holdsFor] of cases) {
        const userRoot = path.join(userHome, ".agents", "skills");
        const protectedRoot = userRoot;
        const holds = holdsFor(userRoot);
        const link = () => linkIt(userRoot, userHome);
        fs.rmSync(path.join(defaultDir, ".agents"), { recursive: true, force: true });
        fs.mkdirSync(holds, { recursive: true });
        fs.mkdirSync(path.join(defaultDir, ".agents"), { recursive: true });
        writeUserLevel(holds);
        link();
        const warn = vi.spyOn(serverLogger, "warn");
        try {
          for (let run = 0; run < 2; run++) {
            await writeSkillsToWorkspace(defaultDir, [FOO], { dialects: [".claude/skills"], protectedRoots: [protectedRoot] });
            expect(managedSkillNames(holds), `${label}, write ${run + 1}`).toEqual(["foo"]);
            expect(fs.existsSync(path.join(holds, "foo", "SKILL.md")), label).toBe(true);
          }
          expect(linkedLogs(warn), label).toEqual([
            [{ tag: "skills", op: "own_agent_dir_linked_to_user_skills", dialect: ".agents/skills" }, "skills.own_agent_dir_linked_to_user_skills"],
          ]);
          expect(JSON.stringify(warn.mock.calls), label).not.toContain(ownHome);
        } finally {
          warn.mockRestore();
        }
        expect(fs.existsSync(path.join(defaultDir, ".claude/skills/foo/SKILL.md")), label).toBe(true);
      }
    });

    it("a user-level skills dir that links to libi's own dialect root is not removed from by a dropped dialect either", async () => {
      const { getLibiAgentDir } = await import("@/lib/libi-home");
      const defaultDir = getLibiAgentDir();
      await writeSkillsToWorkspace(defaultDir, [FOO]);
      const userRoot = path.join(ownHome, "user-home", ".agents", "skills");
      fs.mkdirSync(path.dirname(userRoot), { recursive: true });
      fs.symlinkSync(path.join(defaultDir, ".agents", "skills"), userRoot, "dir");
      writeUserLevel(userRoot);

      await writeSkillsToWorkspace(defaultDir, [FOO], { dialects: [".claude/skills"], protectedRoots: [userRoot] });
      expect(managedSkillNames(userRoot)).toEqual(["foo"]);
      expect(fs.existsSync(path.join(defaultDir, ".agents", "skills", "foo", "SKILL.md"))).toBe(true);
    });

    it("a written dialect whose root links to a user-level skills dir never cleans up the user's own skills there", async () => {
      const { getLibiAgentDir } = await import("@/lib/libi-home");
      const defaultDir = getLibiAgentDir();
      const userRoot = path.join(ownHome, "user-home", ".claude", "skills");
      fs.mkdirSync(path.join(userRoot, "mine"), { recursive: true });
      fs.writeFileSync(path.join(userRoot, "mine", "SKILL.md"), "# mine");
      fs.mkdirSync(path.join(defaultDir, ".claude"), { recursive: true });
      fs.symlinkSync(userRoot, path.join(defaultDir, ".claude", "skills"), "dir");

      await writeSkillsToWorkspace(defaultDir, [FOO], { protectedRoots: [userRoot] });
      expect(fs.readFileSync(path.join(userRoot, "mine", "SKILL.md"), "utf-8")).toBe("# mine");
      expect(managedSkillNames(userRoot)).toEqual(["foo"]);
    });

    it("logs how many skills were skipped writing through a protected link, without naming them", async () => {
      const { getLibiAgentDir } = await import("@/lib/libi-home");
      const defaultDir = getLibiAgentDir();
      const userRoot = path.join(ownHome, "user-home", ".claude", "skills");
      fs.mkdirSync(path.join(userRoot, "foo"), { recursive: true });
      fs.writeFileSync(path.join(userRoot, "foo", "SKILL.md"), "# mine");
      fs.mkdirSync(path.join(defaultDir, ".claude"), { recursive: true });
      fs.symlinkSync(userRoot, path.join(defaultDir, ".claude", "skills"), "dir");

      const info = vi.spyOn(serverLogger, "info");
      try {
        await writeSkillsToWorkspace(defaultDir, [FOO], { protectedRoots: [userRoot] });
        const written = info.mock.calls.find((c) => (c[0] as { op?: string } | undefined)?.op === "workspace_written");
        expect(written?.[0]).toMatchObject({ skipped: 1 });
        expect(JSON.stringify(written)).not.toContain("foo");
      } finally {
        info.mockRestore();
      }
    });
  });

  describe("protected roots are resolved once per sync", () => {
    it("asks a protected root's realpath once per sync, not once per dialect", async () => {
      const { getLibiAgentDir } = await import("@/lib/libi-home");
      const defaultDir = getLibiAgentDir();
      const userRoot = path.join(ownHome, "user-home", ".claude", "skills");
      fs.mkdirSync(userRoot, { recursive: true });
      const native = vi.mocked(fs.realpathSync.native);
      native.mockClear();

      await writeSkillsToWorkspace(defaultDir, [FOO], { protectedRoots: [userRoot] });

      // Two dialects are written on every default-dir sync; a protected root resolved once per
      // sync — not once per dialect — is asked for exactly once, not `SKILL_DIALECTS.length` times.
      const callsForRoot = native.mock.calls.filter(([p]) => p === userRoot).length;
      expect(callsForRoot).toBe(1);
    });

    it("skips a protected root that does not exist, without a JS realpath walk", async () => {
      const { getLibiAgentDir } = await import("@/lib/libi-home");
      const defaultDir = getLibiAgentDir();
      const missingRoot = path.join(ownHome, "user-home-missing", ".agents", "skills");
      const jsRealpath = vi.mocked(fs.realpathSync);
      jsRealpath.mockClear();

      await expect(writeSkillsToWorkspace(defaultDir, [FOO], { protectedRoots: [missingRoot] })).resolves.toBeUndefined();

      expect(jsRealpath.mock.calls.some(([p]) => p === missingRoot)).toBe(false);
      // Nothing is protected there, so libi still writes its own dir plainly.
      expect(fs.existsSync(path.join(defaultDir, ".claude/skills/foo/SKILL.md"))).toBe(true);
    });
  });

  it("a dialect left out with an unreadable manifest: libi's own agent dir removes nothing quietly, another folder reports it", async () => {
    const { getLibiAgentDir } = await import("@/lib/libi-home");
    const defaultDir = getLibiAgentDir();
    for (const dir of [defaultDir, wsManifest]) {
      await writeSkillsToWorkspace(dir, [FOO]);
      fs.writeFileSync(path.join(dir, ".claude/skills/.libi-managed.json"), "{");
    }

    await expect(writeSkillsToWorkspace(defaultDir, [FOO], { dialects: [".agents/skills"] })).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(defaultDir, ".claude/skills/foo/SKILL.md"))).toBe(true);

    // `.claude/skills` is left out of `dialects` here, so it goes through the
    // REMOVE path (`removeSkillsFromRoot`), which gets the remove-specific message.
    await expect(writeSkillsToWorkspace(wsManifest, [FOO], { dialects: [".agents/skills"] })).rejects.toThrow(
      UNREADABLE_REMOVE_MESSAGE,
    );
    expect(fs.existsSync(path.join(wsManifest, ".claude/skills/foo/SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(wsManifest, ".claude/skills/.libi-managed.json"), "utf-8")).toBe("{");
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

describe("writeSkillsToRoot — one skills root outside libi's own dir", () => {
  let root: string;
  beforeEach(() => {
    root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "root-")), ".claude", "skills");
  });
  afterEach(() => {
    fs.rmSync(path.dirname(path.dirname(root)), { recursive: true, force: true });
  });

  it("writes every skill, records exactly those names in the manifest, and reports counts", () => {
    const r = writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true });
    expect(r).toEqual({ writes: 3, removed: 0, skipped: [] });
    expect(fs.readFileSync(path.join(root, "foo", "SKILL.md"), "utf-8")).toContain("Foo body");
    expect(managedSkillNames(root)).toEqual(["bar", "foo"]);
  });

  it("skips a skill whose dir exists but is not libi's, reports it, and leaves it untouched", () => {
    fs.mkdirSync(path.join(root, "foo"), { recursive: true });
    fs.writeFileSync(path.join(root, "foo", "SKILL.md"), "# the user's own foo");
    const r = writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true });
    expect(r.skipped).toEqual(["foo"]);
    expect(r.writes).toBe(1);
    expect(fs.readFileSync(path.join(root, "foo", "SKILL.md"), "utf-8")).toBe("# the user's own foo");
    expect(managedSkillNames(root)).toEqual(["bar"]);
    // A later run still skips it — it never enters the manifest.
    expect(writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true }).skipped).toEqual(["foo"]);
  });

  it("removes only manifest names that are no longer wanted, never a foreign dir", () => {
    writeSkillsToRoot(root, [makeSkill("old")], { external: true });
    fs.mkdirSync(path.join(root, "theirs"), { recursive: true });
    const r = writeSkillsToRoot(root, [makeSkill("new")], { external: true });
    expect(r.removed).toBe(1);
    expect(fs.existsSync(path.join(root, "old"))).toBe(false);
    expect(fs.existsSync(path.join(root, "theirs"))).toBe(true);
    expect(managedSkillNames(root)).toEqual(["new"]);
  });

  it("libi's own dir (external: false) grandfathers a pre-manifest root: every non-enabled dir is cleaned", () => {
    fs.mkdirSync(path.join(root, "stale"), { recursive: true });
    fs.writeFileSync(path.join(root, "stale", "SKILL.md"), "stale");
    const r = writeSkillsToRoot(root, [FOO], { external: false });
    expect(r.skipped).toEqual([]);
    expect(fs.existsSync(path.join(root, "stale"))).toBe(false);
    expect(fs.existsSync(path.join(root, "foo", "SKILL.md"))).toBe(true);
  });

  it("does not sweep GEMINI.md or .codex/skills next to an external root", () => {
    const workspace = path.dirname(path.dirname(root));
    fs.writeFileSync(path.join(workspace, "GEMINI.md"), "<!-- libi-skills-start -->\n");
    fs.mkdirSync(path.join(workspace, ".codex", "skills", "x"), { recursive: true });
    writeSkillsToRoot(root, [FOO], { external: true });
    expect(fs.existsSync(path.join(workspace, "GEMINI.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".codex", "skills", "x"))).toBe(true);
  });
});

describe("removeSkillsFromRoot", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rm-"));
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("removes the manifest's dirs and the manifest, then the root when empty — never the parent", () => {
    const root = path.join(workspace, ".claude", "skills");
    writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true });
    expect(removeSkillsFromRoot(root)).toEqual({ removed: 2 });
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".claude"))).toBe(true);
  });

  it("keeps a foreign dir, and then keeps the root because it is not empty", () => {
    const root = path.join(workspace, ".agents", "skills");
    writeSkillsToRoot(root, [FOO], { external: true });
    fs.mkdirSync(path.join(root, "theirs"));
    expect(removeSkillsFromRoot(root)).toEqual({ removed: 1 });
    expect(fs.existsSync(path.join(root, "theirs"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".libi-managed.json"))).toBe(false);
  });

  it("does nothing without a manifest, even when dirs exist", () => {
    const root = path.join(workspace, ".claude", "skills");
    fs.mkdirSync(path.join(root, "foo"), { recursive: true });
    expect(removeSkillsFromRoot(root)).toEqual({ removed: 0 });
    expect(fs.existsSync(path.join(root, "foo"))).toBe(true);
  });

  it("a missing root is a no-op", () => {
    expect(removeSkillsFromRoot(path.join(workspace, "nope"))).toEqual({ removed: 0 });
  });

  it("a root that is itself a link removes nothing at its target, external or not — libi's skills and manifest there stay", () => {
    const target = path.join(workspace, "shared", "skills");
    writeSkillsToRoot(target, [FOO, makeSkill("bar")], { external: true });
    const root = path.join(workspace, "project", ".claude", "skills");
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.symlinkSync(target, root, "dir");
    expect(removeSkillsFromRoot(root)).toEqual({ removed: 0 });
    expect(removeSkillsFromRoot(root, { external: true })).toEqual({ removed: 0 });
    expect(fs.existsSync(path.join(target, "foo", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "bar", "SKILL.md"))).toBe(true);
    expect(managedSkillNames(target)).toEqual(["bar", "foo"]);
    expect(fs.lstatSync(root).isSymbolicLink()).toBe(true);
  });

  it("a root that is a file removes nothing", () => {
    const root = path.join(workspace, "skills");
    fs.writeFileSync(root, "not a folder");
    expect(removeSkillsFromRoot(root, { external: true })).toEqual({ removed: 0 });
    expect(fs.readFileSync(root, "utf-8")).toBe("not a folder");
  });

  it("with rootMayBeLink, a linked root (a user-level skills dir the user linked) is removed through, the link itself kept", () => {
    const target = path.join(workspace, "dotfiles", "skills");
    writeSkillsToRoot(target, [FOO], { external: true });
    fs.mkdirSync(path.join(target, "theirs"));
    const root = path.join(workspace, "home", ".claude", "skills");
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.symlinkSync(target, root, "dir");
    expect(removeSkillsFromRoot(root, { external: true, rootMayBeLink: true })).toEqual({ removed: 1 });
    expect(fs.existsSync(path.join(target, "foo"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".libi-managed.json"))).toBe(false);
    expect(fs.existsSync(path.join(target, "theirs"))).toBe(true);
    expect(fs.lstatSync(root).isSymbolicLink()).toBe(true);
  });
});

describe("a skills manifest is untrusted input", () => {
  // The manifest is a JSON file every consumer here trusts to name plain
  // subdirectories of `root`. If it instead names `../x`, `..`, an absolute
  // path, a multi-segment path, or an empty string, every reader must drop
  // that entry before it reaches `path.join(root, name)` — otherwise a
  // corrupted or hand-edited manifest in a user's own project deletes files
  // outside the skills root.
  let workspace: string;
  let root: string; // workspace/.claude/skills
  let claudeDir: string; // workspace/.claude — root's parent
  let outsideDir: string; // claudeDir/outside — a sibling of root, reachable via "../outside"
  let outsideMarker: string;
  let siblingMarker: string; // a file directly in claudeDir, reachable if ".." deletes the whole parent
  let absTarget: string; // an absolute path elsewhere in the temp area
  let absMarker: string;

  function writeMaliciousManifest(managedRoot: string) {
    fs.mkdirSync(path.join(managedRoot, "real-skill"), { recursive: true });
    fs.writeFileSync(path.join(managedRoot, "real-skill", "SKILL.md"), "# real");
    fs.writeFileSync(
      path.join(managedRoot, ".libi-managed.json"),
      JSON.stringify({ managed: ["../outside", "..", absTarget, "a/b", "", "real-skill"] }, null, 2) + "\n",
    );
  }

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ws-untrusted-manifest-"));
    claudeDir = path.join(workspace, ".claude");
    root = path.join(claudeDir, "skills");
    fs.mkdirSync(root, { recursive: true });

    outsideDir = path.join(claudeDir, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    outsideMarker = path.join(outsideDir, "marker.txt");
    fs.writeFileSync(outsideMarker, "keep me");

    siblingMarker = path.join(claudeDir, "sibling-file.txt");
    fs.writeFileSync(siblingMarker, "keep me too");

    absTarget = fs.mkdtempSync(path.join(os.tmpdir(), "abs-target-"));
    absMarker = path.join(absTarget, "marker.txt");
    fs.writeFileSync(absMarker, "keep me three");
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(absTarget, { recursive: true, force: true });
  });

  it("managedSkillNames drops every entry that is not a plain folder name", () => {
    writeMaliciousManifest(root);
    expect(managedSkillNames(root)).toEqual(["real-skill"]);
  });

  it("removeSkillsFromRoot deletes only the real managed dir, never escapes the root", () => {
    writeMaliciousManifest(root);
    const result = removeSkillsFromRoot(root);
    expect(result).toEqual({ removed: 1 });
    expect(fs.existsSync(outsideMarker)).toBe(true);
    expect(fs.existsSync(siblingMarker)).toBe(true);
    expect(fs.existsSync(absMarker)).toBe(true);
  });

  it("writeSkillsToRoot orphan cleanup deletes only the real managed dir, never escapes the root", () => {
    writeMaliciousManifest(root);
    const r = writeSkillsToRoot(root, [], { external: true });
    expect(r.removed).toBe(1);
    expect(fs.existsSync(outsideMarker)).toBe(true);
    expect(fs.existsSync(siblingMarker)).toBe(true);
    expect(fs.existsSync(absMarker)).toBe(true);
    expect(fs.existsSync(path.join(root, "real-skill"))).toBe(false);
  });

  it("sweepLegacyDialect deletes only the real managed dir, never escapes the dialect root", () => {
    const dialect = ".codex/skills";
    const legacyRoot = path.join(workspace, dialect);
    fs.mkdirSync(legacyRoot, { recursive: true });
    const legacyOutsideDir = path.join(workspace, ".codex", "outside");
    fs.mkdirSync(legacyOutsideDir, { recursive: true });
    const legacyOutsideMarker = path.join(legacyOutsideDir, "marker.txt");
    fs.writeFileSync(legacyOutsideMarker, "keep me");
    writeMaliciousManifest(legacyRoot);

    sweepLegacyDialect(workspace, dialect);

    expect(fs.existsSync(legacyOutsideMarker)).toBe(true);
    expect(fs.existsSync(absMarker)).toBe(true);
  });
});

describe("writeSkillsToWorkspace with a dialect subset", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ws-dialects-"));
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("writes only the listed dialects and removes libi's copies from the others", async () => {
    await writeSkillsToWorkspace(workspace, [FOO]);
    expect(fs.existsSync(path.join(workspace, ".claude/skills/foo/SKILL.md"))).toBe(true);
    await writeSkillsToWorkspace(workspace, [FOO], { dialects: [".agents/skills"] });
    expect(fs.existsSync(path.join(workspace, ".claude/skills/foo"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".claude/skills"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".agents/skills/foo/SKILL.md"))).toBe(true);
    // Restoring the dialect brings the copies back.
    await writeSkillsToWorkspace(workspace, [FOO], { dialects: SKILL_DIALECTS });
    expect(fs.existsSync(path.join(workspace, ".claude/skills/foo/SKILL.md"))).toBe(true);
  });
});

describe("an external root: entries the user owns are never written or deleted through", () => {
  // Outside libi's own agent dir, only a REAL directory whose exact name the
  // manifest lists is libi's. A symlink (to a dir or dangling), a regular file,
  // or a differently cased name is the user's — and the default macOS and
  // Windows filesystems are case-insensitive, so `foo` would land inside `Foo/`.
  let workspace: string;
  let root: string;
  let userSkill: string; // a skill the user keeps elsewhere and links in

  const entriesOf = (dir: string) => fs.readdirSync(dir).filter((n) => n !== ".libi-managed.json").sort();

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ws-foreign-entries-"));
    root = path.join(workspace, ".claude", "skills");
    fs.mkdirSync(root, { recursive: true });
    userSkill = path.join(workspace, "my-dotfiles", "foo");
    fs.mkdirSync(path.join(userSkill, "notes"), { recursive: true });
    fs.writeFileSync(path.join(userSkill, "SKILL.md"), "# the user's own foo");
    fs.writeFileSync(path.join(userSkill, "notes", "keep.md"), "keep");
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("skips a symlink named like a skill, never writes through it, and never prunes it", () => {
    fs.symlinkSync(userSkill, path.join(root, "foo"), "dir");

    const r = writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true });

    expect(r.skipped).toEqual(["foo"]);
    expect(fs.readFileSync(path.join(userSkill, "SKILL.md"), "utf-8")).toBe("# the user's own foo");
    expect(fs.existsSync(path.join(userSkill, "templates"))).toBe(false);
    expect(fs.lstatSync(path.join(root, "foo")).isSymbolicLink()).toBe(true);
    expect(managedSkillNames(root)).toEqual(["bar"]);

    // Not wanted any more → still not libi's to prune.
    writeSkillsToRoot(root, [], { external: true });
    expect(fs.lstatSync(path.join(root, "foo")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(userSkill, "notes", "keep.md"), "utf-8")).toBe("keep");
  });

  it("skips a dangling symlink named like a skill and leaves the link as it is", () => {
    fs.symlinkSync(path.join(workspace, "gone"), path.join(root, "foo"), "dir");

    const r = writeSkillsToRoot(root, [FOO], { external: true });

    expect(r.skipped).toEqual(["foo"]);
    expect(fs.lstatSync(path.join(root, "foo")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(workspace, "gone"))).toBe(false);
    expect(managedSkillNames(root)).toEqual([]);
  });

  it("skips a differently cased dir the manifest does not list, and leaves it untouched", () => {
    fs.mkdirSync(path.join(root, "Foo"));
    fs.writeFileSync(path.join(root, "Foo", "SKILL.md"), "# the user's own Foo");

    const r = writeSkillsToRoot(root, [FOO], { external: true });

    expect(r).toEqual({ writes: 0, removed: 0, skipped: ["foo"] });
    expect(fs.readFileSync(path.join(root, "Foo", "SKILL.md"), "utf-8")).toBe("# the user's own Foo");
    expect(entriesOf(root)).toEqual(["Foo"]);
    expect(managedSkillNames(root)).toEqual([]);
  });

  it("skips a regular file named like a skill instead of throwing", () => {
    fs.writeFileSync(path.join(root, "foo"), "a file the user keeps here");

    const r = writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true });

    expect(r.skipped).toEqual(["foo"]);
    expect(fs.readFileSync(path.join(root, "foo"), "utf-8")).toBe("a file the user keeps here");
    expect(managedSkillNames(root)).toEqual(["bar"]);
  });

  it("a manifest-listed dir the user replaced with a link is no longer libi's: skipped, dropped, never written or deleted through", () => {
    writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true });
    fs.rmSync(path.join(root, "foo"), { recursive: true });
    fs.symlinkSync(userSkill, path.join(root, "foo"), "dir");

    const r = writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true });

    expect(r.skipped).toEqual(["foo"]);
    expect(managedSkillNames(root)).toEqual(["bar"]);
    expect(fs.readFileSync(path.join(userSkill, "SKILL.md"), "utf-8")).toBe("# the user's own foo");
    expect(fs.readFileSync(path.join(userSkill, "notes", "keep.md"), "utf-8")).toBe("keep");
    expect(fs.existsSync(path.join(userSkill, "templates"))).toBe(false);
  });

  it("orphan cleanup leaves a manifest-listed entry that is now a link, and its target, alone", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    fs.rmSync(path.join(root, "foo"), { recursive: true });
    fs.symlinkSync(userSkill, path.join(root, "foo"), "dir");

    const r = writeSkillsToRoot(root, [], { external: true });

    expect(r.removed).toBe(0);
    expect(fs.lstatSync(path.join(root, "foo")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(userSkill, "notes", "keep.md"), "utf-8")).toBe("keep");
    expect(managedSkillNames(root)).toEqual([]);
  });

  it("removeSkillsFromRoot leaves a manifest-listed link and its target, removes only real managed dirs", () => {
    writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true });
    fs.rmSync(path.join(root, "foo"), { recursive: true });
    fs.symlinkSync(userSkill, path.join(root, "foo"), "dir");

    expect(removeSkillsFromRoot(root)).toEqual({ removed: 1 });

    expect(fs.existsSync(path.join(root, "bar"))).toBe(false);
    expect(fs.lstatSync(path.join(root, "foo")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(userSkill, "SKILL.md"), "utf-8")).toBe("# the user's own foo");
    expect(fs.readFileSync(path.join(userSkill, "notes", "keep.md"), "utf-8")).toBe("keep");
    expect(fs.existsSync(path.join(root, ".libi-managed.json"))).toBe(false);
  });

  it("removeSkillsFromRoot does not remove a differently cased dir the manifest names only in another case", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    // The user renames libi's dir (on a case-insensitive FS this is the only way `Foo` and `foo` differ).
    fs.renameSync(path.join(root, "foo"), path.join(root, "Foo-tmp"));
    fs.renameSync(path.join(root, "Foo-tmp"), path.join(root, "Foo"));

    expect(removeSkillsFromRoot(root)).toEqual({ removed: 0 });
    expect(fs.existsSync(path.join(root, "Foo", "SKILL.md"))).toBe(true);
  });

  it("a file inside libi's own skill dir that became a link is replaced, never written through", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    const userFile = path.join(workspace, "my-notes.md");
    fs.writeFileSync(userFile, "the user's notes");
    fs.rmSync(path.join(root, "foo", "SKILL.md"));
    fs.symlinkSync(userFile, path.join(root, "foo", "SKILL.md"));

    writeSkillsToRoot(root, [FOO], { external: true });

    expect(fs.readFileSync(userFile, "utf-8")).toBe("the user's notes");
    expect(fs.lstatSync(path.join(root, "foo", "SKILL.md")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(root, "foo", "SKILL.md"), "utf-8")).toContain("Foo body");
  });
});

describe("libi's own dir (external: false) never deletes or writes through a link", () => {
  let workspace: string;
  let root: string;
  let target: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ws-own-links-"));
    root = path.join(workspace, ".claude", "skills");
    fs.mkdirSync(root, { recursive: true });
    target = path.join(workspace, "elsewhere");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "SKILL.md"), "# elsewhere");
    fs.writeFileSync(path.join(target, "keep.md"), "keep");
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("replaces a link named like a skill with a real dir, leaving the link's target intact", () => {
    fs.symlinkSync(target, path.join(root, "foo"), "dir");

    const r = writeSkillsToRoot(root, [FOO], { external: false });

    expect(r.skipped).toEqual([]);
    expect(fs.lstatSync(path.join(root, "foo")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(root, "foo", "SKILL.md"), "utf-8")).toContain("Foo body");
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf-8")).toBe("# elsewhere");
    expect(fs.readFileSync(path.join(target, "keep.md"), "utf-8")).toBe("keep");
  });

  it("orphan cleanup and removeSkillsFromRoot never delete through a manifest-listed link", () => {
    writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: false });
    fs.rmSync(path.join(root, "foo"), { recursive: true });
    fs.symlinkSync(target, path.join(root, "foo"), "dir");

    writeSkillsToRoot(root, [makeSkill("bar")], { external: false });
    expect(fs.readFileSync(path.join(target, "keep.md"), "utf-8")).toBe("keep");

    removeSkillsFromRoot(root);
    expect(fs.readFileSync(path.join(target, "keep.md"), "utf-8")).toBe("keep");
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf-8")).toBe("# elsewhere");
  });
});

describe("a write that fails part-way", () => {
  let workspace: string;
  let root: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ws-partial-"));
    root = path.join(workspace, ".agents", "skills");
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("leaves every dir it already wrote in the manifest, so the next run updates them instead of skipping", () => {
    // `x` is written as a file, so `x/y.md` cannot be created under it: a real
    // ENOTDIR from the filesystem, part-way through the call.
    const broken: Skill = {
      ...makeSkill("broken"),
      supportingFiles: [
        { relPath: "x", contents: "a file" },
        { relPath: path.join("x", "y.md"), contents: "cannot exist" },
      ],
    };
    expect(() => writeSkillsToRoot(root, [makeSkill("alpha"), broken], { external: true })).toThrow();
    expect(fs.existsSync(path.join(root, "alpha", "SKILL.md"))).toBe(true);

    const alpha2: Skill = { ...makeSkill("alpha"), body: "---\nname: alpha\ndescription: alpha skill\n---\nalpha v2\n" };
    const r = writeSkillsToRoot(root, [alpha2], { external: true });

    expect(r.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(root, "alpha", "SKILL.md"), "utf-8")).toContain("alpha v2");
    // The half-written skill was recorded too, so it is libi's to clean up.
    expect(fs.existsSync(path.join(root, "broken"))).toBe(false);
    expect(managedSkillNames(root)).toEqual(["alpha"]);
  });

  it("records a skill only once its writing starts, so an early throw lists no skill that was never begun", () => {
    const broken: Skill = {
      ...makeSkill("broken"),
      supportingFiles: [
        { relPath: "x", contents: "a file" },
        { relPath: path.join("x", "y.md"), contents: "cannot exist" },
      ],
    };
    expect(() => writeSkillsToRoot(root, [broken, makeSkill("alpha")], { external: true })).toThrow();
    expect(fs.existsSync(path.join(root, "alpha"))).toBe(false);
    expect(managedSkillNames(root)).toEqual(["broken"]);

    // A folder the user later creates under the never-started name stays theirs.
    fs.mkdirSync(path.join(root, "alpha"));
    fs.writeFileSync(path.join(root, "alpha", "SKILL.md"), "# the user's own alpha");
    const r = writeSkillsToRoot(root, [makeSkill("alpha")], { external: true });

    expect(r.skipped).toEqual(["alpha"]);
    expect(fs.readFileSync(path.join(root, "alpha", "SKILL.md"), "utf-8")).toBe("# the user's own alpha");
    expect(fs.existsSync(path.join(root, "broken"))).toBe(false);
    expect(managedSkillNames(root)).toEqual([]);
  });
});

describe("an entry's kind comes from lstat, not the directory listing", () => {
  // On Windows, libuv's scandir marks EVERY reparse point as a link — a OneDrive
  // Files On-Demand folder included — while lstat reports a link only for real
  // symlinks and junctions. Trusting the listing would make libi's own folders
  // under a OneDrive-synced root look like the user's links.
  let workspace: string;
  let root: string;
  let realReaddirSync: typeof fs.readdirSync;

  /**
   * Entries listed as links, the way Windows lists a synced folder's reparse points: every entry in
   * `root` and below, or with `rootOnly` only the skills root's own entries. Only a listing with file
   * types changes, since a Dirent is what carries an entry's kind; every other call passes through
   * untouched, including `rmSync`'s own recursion, which on Windows lists Buffers through this export.
   */
  function listEveryEntryAsLink(opts: { rootOnly?: boolean } = {}): void {
    vi.mocked(fs.readdirSync).mockImplementation(((dir: fs.PathLike, options?: unknown) => {
      const real = (realReaddirSync as (d: fs.PathLike, o?: unknown) => unknown)(dir, options);
      const withFileTypes = (options as { withFileTypes?: unknown } | null | undefined)?.withFileTypes === true;
      if (!withFileTypes || !Array.isArray(real) || typeof dir !== "string") return real;
      const abs = path.resolve(dir);
      const inScope = abs === path.resolve(root) || (!opts.rootOnly && abs.startsWith(path.resolve(root) + path.sep));
      if (!inScope) return real;
      return real.map((e: fs.Dirent) =>
        Object.assign(Object.create(Object.getPrototypeOf(e)), e, {
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false,
        }),
      );
    }) as typeof fs.readdirSync);
  }

  let realRmSync: typeof fs.rmSync;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    realReaddirSync = actual.readdirSync;
    realRmSync = actual.rmSync;
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ws-reparse-"));
    root = path.join(workspace, ".claude", "skills");
  });

  afterEach(() => {
    vi.mocked(fs.readdirSync).mockImplementation(realReaddirSync);
    vi.mocked(fs.rmSync).mockImplementation(realRmSync);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("prunes a nested supporting-file folder whose last file went, and never follows a real link, while every entry is listed as a link", () => {
    const nested: Skill = {
      ...FOO,
      supportingFiles: [
        { relPath: path.join("templates", "deep", "x.md"), contents: "X" },
        { relPath: path.join("templates", "keep.md"), contents: "K" },
      ],
    };
    writeSkillsToRoot(root, [nested], { external: true });
    // A folder outside the root holding an empty folder: what a prune that followed a link would delete.
    const elsewhere = path.join(workspace, "elsewhere");
    fs.mkdirSync(path.join(elsewhere, "hollow"), { recursive: true });
    const link = path.join(root, "foo", "linked");
    const lastNestedFile = path.join(root, "foo", "templates", "deep", "x.md");
    // The link appears once the supporting-file walk has listed the skill folder, so the
    // prune is the step that meets it.
    vi.mocked(fs.rmSync).mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      realRmSync(p, o);
      if (String(p) === lastNestedFile) fs.symlinkSync(elsewhere, link, "dir");
    }) as typeof fs.rmSync);
    listEveryEntryAsLink();

    writeSkillsToRoot(root, [{ ...nested, supportingFiles: [nested.supportingFiles[1]] }], { external: true });

    expect(fs.lstatSync(lastNestedFile, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.existsSync(path.join(root, "foo", "templates", "deep"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "foo", "templates", "keep.md"), "utf-8")).toBe("K");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(elsewhere, "hollow")).isDirectory()).toBe(true);
  });

  it("the listing's stand-in really does report libi's folder as a link", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    listEveryEntryAsLink();
    const listed = fs.readdirSync(root, { withFileTypes: true }).find((e) => e.name === "foo");
    expect(listed?.isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(root, "foo")).isDirectory()).toBe(true);
    const nested = fs.readdirSync(path.join(root, "foo"), { withFileTypes: true }).find((e) => e.name === "templates");
    expect(nested?.isSymbolicLink()).toBe(true);
    // Any other listing is the real one.
    const names = fs.readdirSync(root, { encoding: "buffer" });
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => Buffer.isBuffer(n))).toBe(true);
    expect(fs.readdirSync(root).sort()).toEqual([".libi-managed.json", "foo"]);
  });

  it("scoped to the root, the stand-in leaves every listing below it real", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    listEveryEntryAsLink({ rootOnly: true });
    expect(fs.readdirSync(root, { withFileTypes: true }).find((e) => e.name === "foo")?.isSymbolicLink()).toBe(true);
    const nested = fs.readdirSync(path.join(root, "foo"), { withFileTypes: true }).find((e) => e.name === "templates");
    expect(nested?.isDirectory()).toBe(true);
  });

  it("a manifest-listed real folder listed as a link is still libi's: updated, not skipped", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    listEveryEntryAsLink();

    const foo2: Skill = { ...FOO, body: "---\nname: foo\ndescription: Foo skill\n---\nFoo v2\n" };
    const r = writeSkillsToRoot(root, [foo2], { external: true });

    expect(r.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(root, "foo", "SKILL.md"), "utf-8")).toContain("Foo v2");
    // Its supporting-file folder, listed as a link too, is walked as the folder it is.
    expect(fs.readFileSync(path.join(root, "foo", "templates", "x.md"), "utf-8")).toBe("X content");
    expect(managedSkillNames(root)).toEqual(["foo"]);
  });

  it("a manifest-listed real folder listed as a link is still removed as libi's", () => {
    writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true });
    listEveryEntryAsLink({ rootOnly: true });

    expect(writeSkillsToRoot(root, [FOO], { external: true }).removed).toBe(1);
    expect(fs.existsSync(path.join(root, "bar"))).toBe(false);
    expect(removeSkillsFromRoot(root)).toEqual({ removed: 1 });
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe("rejected manifest names are warned about only when libi acts on the manifest", () => {
  let root: string;

  beforeEach(() => {
    root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ws-warn-")), ".claude", "skills");
    fs.mkdirSync(path.join(root, "real-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".libi-managed.json"),
      JSON.stringify({ managed: ["../outside", "real-skill"] }, null, 2) + "\n",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(path.dirname(path.dirname(root)), { recursive: true, force: true });
  });

  const rejectedWarnings = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c: unknown[]) => (c[0] as { op?: string } | undefined)?.op === "manifest_names_rejected");

  it("managedSkillNames reads quietly", () => {
    const warn = vi.spyOn(serverLogger, "warn");
    expect(managedSkillNames(root)).toEqual(["real-skill"]);
    expect(managedSkillNames(root)).toEqual(["real-skill"]);
    expect(rejectedWarnings(warn)).toHaveLength(0);
  });

  it("removeSkillsFromRoot warns", () => {
    const warn = vi.spyOn(serverLogger, "warn");
    removeSkillsFromRoot(root);
    expect(rejectedWarnings(warn)).toHaveLength(1);
  });

  it("writeSkillsToRoot warns", () => {
    const warn = vi.spyOn(serverLogger, "warn");
    writeSkillsToRoot(root, [], { external: true });
    expect(rejectedWarnings(warn)).toHaveLength(1);
  });
});

describe("the skills manifest is shared with another process writing the same root", () => {
  // The Next server and libi's MCP process each sync the same installs, each
  // with its own serialization, so a root's manifest can be mid-write by one
  // while the other reads it.
  let workspace: string;
  let root: string;
  let manifestPath: string;
  let actual: typeof import("node:fs");

  const tempFiles = (): string[] => fs.readdirSync(root).filter((n) => n.endsWith(".tmp"));

  beforeEach(async () => {
    actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ws-manifest-"));
    root = path.join(workspace, ".agents", "skills");
    manifestPath = path.join(root, ".libi-managed.json");
  });

  afterEach(() => {
    vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
    vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
    vi.mocked(fs.rmSync).mockImplementation(actual.rmSync);
    vi.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("an external root whose manifest is half-written throws, and leaves the manifest and every skill dir as they were", () => {
    writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true });
    const full = fs.readFileSync(manifestPath, "utf-8");
    const fooBefore = fs.readFileSync(path.join(root, "foo", "SKILL.md"), "utf-8");
    // The other process's plain write has truncated the file and not finished.
    const truncated = full.slice(0, Math.floor(full.length / 2));
    fs.writeFileSync(manifestPath, truncated);

    const foo2: Skill = { ...FOO, body: "---\nname: foo\ndescription: Foo skill\n---\nFoo v2\n" };
    expect(() => writeSkillsToRoot(root, [foo2, makeSkill("baz")], { external: true })).toThrow(
      UNREADABLE_MESSAGE,
    );

    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(truncated);
    expect(fs.readFileSync(path.join(root, "foo", "SKILL.md"), "utf-8")).toBe(fooBefore);
    expect(fs.existsSync(path.join(root, "bar", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "baz"))).toBe(false);
    expect(tempFiles()).toEqual([]);

    // Once the other write lands, the next sync updates libi's skills as usual.
    fs.writeFileSync(manifestPath, full);
    const r = writeSkillsToRoot(root, [foo2, makeSkill("baz")], { external: true });
    expect(r.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(root, "foo", "SKILL.md"), "utf-8")).toContain("Foo v2");
    expect(fs.existsSync(path.join(root, "bar"))).toBe(false);
    expect(managedSkillNames(root)).toEqual(["baz", "foo"]);
  });

  it("an external root throws for a manifest that is empty, not a manifest, or cannot be read", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    for (const contents of ["", "{}", '{"managed":"foo"}', "null"]) {
      fs.writeFileSync(manifestPath, contents);
      expect(() => writeSkillsToRoot(root, [FOO], { external: true })).toThrow(UNREADABLE_MESSAGE);
      expect(fs.readFileSync(manifestPath, "utf-8")).toBe(contents);
    }

    fs.writeFileSync(manifestPath, JSON.stringify({ managed: ["foo"] }));
    const before = fs.readFileSync(manifestPath, "utf-8");
    vi.mocked(fs.readFileSync).mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (String(p) === manifestPath) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return (actual.readFileSync as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(p, o);
    }) as typeof fs.readFileSync);
    expect(() => writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true })).toThrow(
      UNREADABLE_MESSAGE,
    );
    vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(before);
    expect(fs.existsSync(path.join(root, "bar"))).toBe(false);
  });

  it("a missing manifest is still simply absent: an external root skips what is there and writes the rest", () => {
    fs.mkdirSync(path.join(root, "foo"), { recursive: true });
    const r = writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true });
    expect(r.skipped).toEqual(["foo"]);
    expect(managedSkillNames(root)).toEqual(["bar"]);
  });

  it("libi's own dir still grandfathers an unreadable manifest", () => {
    writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: false });
    fs.writeFileSync(manifestPath, '{"managed": ["fo');
    const r = writeSkillsToRoot(root, [FOO], { external: false });
    expect(r.removed).toBe(1);
    expect(fs.existsSync(path.join(root, "bar"))).toBe(false);
    expect(managedSkillNames(root)).toEqual(["foo"]);
  });

  it("managedSkillNames reads an unreadable manifest as empty, without throwing", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    fs.writeFileSync(manifestPath, "{");
    expect(managedSkillNames(root)).toEqual([]);
  });

  it("writes the manifest to a unique temp file renamed over it, leaves no temp file, and skips an unchanged manifest", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    const renames = vi.mocked(fs.renameSync).mock.calls.filter((c) => String(c[1]) === manifestPath);
    expect(renames.length).toBeGreaterThan(0);
    for (const [from] of renames) {
      expect(path.dirname(String(from))).toBe(root);
      expect(path.basename(String(from))).toMatch(/^\.libi-managed\.json\.\d+\.[0-9a-f]+\.tmp$/);
    }
    expect(tempFiles()).toEqual([]);
    expect(managedSkillNames(root)).toEqual(["foo"]);

    vi.mocked(fs.renameSync).mockClear();
    writeSkillsToRoot(root, [FOO], { external: true });
    expect(vi.mocked(fs.renameSync)).not.toHaveBeenCalled();
  });

  it("a failed rename removes its temp file, keeps the previous manifest, and throws", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    const before = fs.readFileSync(manifestPath, "utf-8");
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    });

    expect(() => writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true })).toThrow("EPERM");
    expect(tempFiles()).toEqual([]);
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(before);
  });

  it("a temp write that fails part-way removes the partial temp file and throws", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    const before = fs.readFileSync(manifestPath, "utf-8");
    vi.mocked(fs.writeFileSync).mockImplementation(((p: fs.PathOrFileDescriptor, data: unknown, o?: unknown) => {
      if (String(p).endsWith(".tmp")) {
        (actual.writeFileSync as (p: fs.PathOrFileDescriptor, d: unknown) => void)(p, "{");
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return (actual.writeFileSync as (p: fs.PathOrFileDescriptor, d: unknown, o?: unknown) => void)(p, data, o);
    }) as typeof fs.writeFileSync);

    expect(() => writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true })).toThrow("ENOSPC");
    expect(tempFiles()).toEqual([]);
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(before);
  });

  it("an unreadable external manifest says how to recover, briefly and without a path", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    fs.writeFileSync(manifestPath, "{");
    let message = "";
    try {
      writeSkillsToRoot(root, [FOO], { external: true });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(UNREADABLE_MESSAGE);
    expect(message).not.toContain(workspace);
    // An install row shows at most the first 120 characters of a message.
    expect(message.length).toBeLessThanOrEqual(120);
  });

  it("a listed entry that became a link leaves the manifest before an orphan removal that throws", () => {
    const userSkill = path.join(workspace, "my-dotfiles", "foo");
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, "SKILL.md"), "# the user's own foo");
    writeSkillsToRoot(root, [FOO, makeSkill("bar"), makeSkill("old")], { external: true });
    fs.rmSync(path.join(root, "foo"), { recursive: true });
    fs.symlinkSync(userSkill, path.join(root, "foo"), "dir");
    const oldDir = path.join(root, "old");
    vi.mocked(fs.rmSync).mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      if (String(p) === oldDir) throw Object.assign(new Error("EBUSY: resource busy or locked, rmdir"), { code: "EBUSY" });
      return actual.rmSync(p, o);
    }) as typeof fs.rmSync);

    expect(() => writeSkillsToRoot(root, [makeSkill("bar")], { external: true })).toThrow("EBUSY");

    const listed = JSON.parse(actual.readFileSync(manifestPath, "utf-8")).managed;
    expect(listed).not.toContain("foo");
    // `old` is still a real folder libi wrote, so it stays listed for the next run to remove.
    expect(listed).toEqual(["bar", "old"]);
    expect(fs.lstatSync(path.join(root, "foo")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(userSkill, "SKILL.md"), "utf-8")).toBe("# the user's own foo");
  });

  it("records each orphan removal in the manifest as it happens, so a later orphan's throw doesn't re-list an already-removed one", () => {
    writeSkillsToRoot(root, [makeSkill("alpha"), makeSkill("bravo")], { external: true });

    // Both `alpha` and `bravo` are orphans on this call (neither is wanted any
    // more). The first `rmSync` (whichever orphan the writer reaches first)
    // succeeds for real; the second throws — mirroring a folder that's briefly
    // locked by another process partway through the sweep.
    let calls = 0;
    vi.mocked(fs.rmSync).mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      calls++;
      if (calls === 2) throw Object.assign(new Error("EBUSY: resource busy or locked, rmdir"), { code: "EBUSY" });
      return actual.rmSync(p, o);
    }) as typeof fs.rmSync);

    expect(() => writeSkillsToRoot(root, [], { external: true })).toThrow("EBUSY");

    // Whichever name's dir is actually gone is the one the writer removed
    // first (and must no longer be listed); the other's removal threw, so its
    // dir is still there and it must still be listed for the next run.
    const removedFirst = fs.existsSync(path.join(root, "alpha")) ? "bravo" : "alpha";
    const stillPresent = removedFirst === "alpha" ? "bravo" : "alpha";
    expect(fs.existsSync(path.join(root, stillPresent))).toBe(true);

    const listed = JSON.parse(actual.readFileSync(manifestPath, "utf-8")).managed;
    expect(listed).not.toContain(removedFirst);
    expect(listed).toEqual([stillPresent]);
  });

  it("removeSkillsFromRoot on an external root throws for an unreadable manifest and leaves everything in place", () => {
    writeSkillsToRoot(root, [FOO, makeSkill("bar")], { external: true });
    fs.writeFileSync(manifestPath, '{"managed": ["fo');

    expect(() => removeSkillsFromRoot(root, { external: true })).toThrow(UNREADABLE_REMOVE_MESSAGE);

    expect(fs.readFileSync(manifestPath, "utf-8")).toBe('{"managed": ["fo');
    expect(fs.existsSync(path.join(root, "foo", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "bar", "SKILL.md"))).toBe(true);
  });

  it("removeSkillsFromRoot's unreadable-manifest message differs from a write's, reads right for a Remove press, and stays short", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    fs.writeFileSync(manifestPath, "{");

    let writeMessage = "";
    try {
      writeSkillsToRoot(root, [FOO], { external: true });
    } catch (err) {
      writeMessage = (err as Error).message;
    }
    let removeMessage = "";
    try {
      removeSkillsFromRoot(root, { external: true });
    } catch (err) {
      removeMessage = (err as Error).message;
    }

    expect(writeMessage).toBe(UNREADABLE_MESSAGE);
    expect(removeMessage).toBe(UNREADABLE_REMOVE_MESSAGE);
    expect(removeMessage).not.toBe(writeMessage);
    expect(removeMessage).not.toContain(workspace);
    expect(removeMessage.length).toBeLessThanOrEqual(120);
  });

  it("removeSkillsFromRoot on an external root without a manifest is still a no-op", () => {
    fs.mkdirSync(path.join(root, "foo"), { recursive: true });
    expect(removeSkillsFromRoot(root, { external: true })).toEqual({ removed: 0 });
    expect(fs.existsSync(path.join(root, "foo"))).toBe(true);
    expect(removeSkillsFromRoot(path.join(workspace, "nope"), { external: true })).toEqual({ removed: 0 });
  });

  it("removeSkillsFromRoot without the external option keeps removing nothing for an unreadable manifest", () => {
    writeSkillsToRoot(root, [FOO], { external: false });
    fs.writeFileSync(manifestPath, "{");
    expect(removeSkillsFromRoot(root)).toEqual({ removed: 0 });
    expect(removeSkillsFromRoot(root, { external: false })).toEqual({ removed: 0 });
    expect(fs.existsSync(path.join(root, "foo", "SKILL.md"))).toBe(true);
  });

  it("clears a temp manifest a crashed write left over a minute ago, and leaves a fresh one, a look-alike and a link", () => {
    fs.mkdirSync(root, { recursive: true });
    const stale = path.join(root, ".libi-managed.json.4242.0123456789ab.tmp");
    const fresh = path.join(root, ".libi-managed.json.4343.ba9876543210.tmp");
    const lookalike = path.join(root, ".libi-managed.json.old.tmp");
    const staleLink = path.join(root, ".libi-managed.json.4444.aaaaaaaaaaaa.tmp");
    for (const f of [stale, fresh, lookalike]) fs.writeFileSync(f, "{");
    fs.symlinkSync(path.join(workspace, "nowhere.txt"), staleLink);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(lookalike, old, old);
    fs.lutimesSync(staleLink, old, old);

    writeSkillsToRoot(root, [FOO], { external: true });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(fresh, "utf-8")).toBe("{");
    expect(fs.readFileSync(lookalike, "utf-8")).toBe("{");
    expect(fs.lstatSync(staleLink).isSymbolicLink()).toBe(true);
    expect(managedSkillNames(root)).toEqual(["foo"]);
  });

  it("clears a crashed temp manifest before an unreadable manifest stops the write", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    const stale = path.join(root, ".libi-managed.json.4242.0123456789ab.tmp");
    fs.writeFileSync(stale, "{");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(stale, old, old);
    fs.writeFileSync(manifestPath, "{");

    expect(() => writeSkillsToRoot(root, [FOO], { external: true })).toThrow(UNREADABLE_MESSAGE);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("removeSkillsFromRoot clears a crashed temp manifest, so the emptied root still goes", () => {
    writeSkillsToRoot(root, [FOO], { external: true });
    const stale = path.join(root, ".libi-managed.json.4242.0123456789ab.tmp");
    fs.writeFileSync(stale, "{");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(stale, old, old);

    expect(removeSkillsFromRoot(root, { external: true })).toEqual({ removed: 1 });
    expect(fs.existsSync(root)).toBe(false);
  });
});

describe("skills logs never carry a folder path", () => {
  // A folder's name can be a private detail of a user's project, so a
  // `tag: "skills"` log line must never let one through — recursively, since
  // a path can hide inside a nested field or an error's own message/stack.
  const containsPath = (value: unknown, needle: string, seen: Set<unknown> = new Set()): boolean => {
    if (value == null) return false;
    if (typeof value === "string") return value.includes(needle);
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (value instanceof Error) {
      return (
        containsPath(value.message, needle, seen) ||
        containsPath(value.stack, needle, seen) ||
        containsPath({ ...value }, needle, seen)
      );
    }
    if (Array.isArray(value)) return value.some((v) => containsPath(v, needle, seen));
    return Object.values(value as Record<string, unknown>).some((v) => containsPath(v, needle, seen));
  };

  const assertNoPathLogged = (spy: { mock: { calls: unknown[][] } }, needle: string): void => {
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        expect(containsPath(arg, needle)).toBe(false);
      }
    }
  };

  let tempDir: string;
  let root: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-nopath-"));
    root = path.join(tempDir, ".claude", "skills");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".libi-managed.json"), "not json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("the unreadable-manifest warning names no path, on a write or a remove", () => {
    const warn = vi.spyOn(serverLogger, "warn");
    expect(() => writeSkillsToRoot(root, [FOO], { external: true })).toThrow(UNREADABLE_MESSAGE);
    expect(() => removeSkillsFromRoot(root, { external: true })).toThrow(UNREADABLE_REMOVE_MESSAGE);
    assertNoPathLogged(warn, tempDir);
  });
});

describe("an external root only ever receives skills with plain names and plain relative file paths", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "writer-unsafe-"));
    root = path.join(base, "proj", ".claude", "skills");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("skips a skill whose name or supporting-file path could leave its folder, writes the rest, and logs only a count", () => {
    const warn = vi.spyOn(serverLogger, "warn");
    const escapingName = makeSkill("../escape");
    const separatorName = makeSkill("a\\b");
    const escapingFile = { ...makeSkill("escaping-file"), supportingFiles: [{ relPath: "../../outside.md", contents: "x" }] };
    const absoluteFile = { ...makeSkill("absolute-file"), supportingFiles: [{ relPath: path.join(base, "abs.md"), contents: "x" }] };
    const r = writeSkillsToRoot(root, [escapingName, separatorName, escapingFile, absoluteFile, FOO], { external: true });
    expect(managedSkillNames(root)).toEqual(["foo"]);
    expect(fs.readdirSync(root).sort()).toEqual([".libi-managed.json", "foo"]);
    expect(fs.existsSync(path.join(root, "foo", "templates", "x.md"))).toBe(true);
    expect(fs.existsSync(path.join(base, "proj", ".claude", "escape"))).toBe(false);
    expect(fs.existsSync(path.join(base, "proj", ".claude", "outside.md"))).toBe(false);
    expect(fs.existsSync(path.join(base, "abs.md"))).toBe(false);
    expect(r.skipped).toEqual([]);
    const rejected = warn.mock.calls.filter((c) => (c[0] as { op?: string } | undefined)?.op === "skills_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0][0]).toMatchObject({ tag: "skills", rejected: 4 });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/escape|outside|abs\.md|a\\\\b/);
  });
});

describe("a supporting file's relPath names the same file however its separators are spelled", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "writer-sep-"));
    root = path.join(base, ".claude", "skills");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("an unchanged supporting file whose relPath is spelled unlike the folder listing is neither removed nor rewritten", () => {
    const skill: Skill = { ...FOO, supportingFiles: [{ relPath: "./ref//notes.md", contents: "N" }] };
    writeSkillsToRoot(root, [skill], { external: true });
    expect(writeSkillsToRoot(root, [skill], { external: true })).toEqual({ writes: 0, removed: 0, skipped: [] });
    expect(fs.readFileSync(path.join(root, "foo", "ref", "notes.md"), "utf-8")).toBe("N");
  });

  it("on Windows a relPath written with / matches the listing's \\ path, and is written to the nested file", () => {
    const listed = path.win32.join(".", "ref", "notes.md");
    expect(supportingFileKey("ref/notes.md", path.win32)).toBe(supportingFileKey(listed, path.win32));
    expect(supportingFileKey("ref/notes.md", path.win32)).toBe("ref\\notes.md");
    expect(supportingFilePath("C:\\work\\.claude\\skills\\foo", "ref/notes.md", path.win32)).toBe(
      "C:\\work\\.claude\\skills\\foo\\ref\\notes.md",
    );
    expect(supportingFileKey("ref/notes.md", path.posix)).toBe(supportingFileKey(path.posix.join(".", "ref", "notes.md"), path.posix));
  });
});

describe("isSameOrInsidePath", () => {
  const base = path.join(path.parse(process.cwd()).root, "Users", "me", ".agents", "skills");

  it("matches the dir itself and anything inside it, never a sibling sharing its name as a prefix", () => {
    expect(isSameOrInsidePath(base, base, "linux")).toBe(true);
    expect(isSameOrInsidePath(path.join(base, "nested"), base, "linux")).toBe(true);
    expect(isSameOrInsidePath(`${base}2`, base, "linux")).toBe(false);
    expect(isSameOrInsidePath(path.dirname(base), base, "linux")).toBe(false);
  });

  it("ignores letter case on win32 and darwin, whose default disks do, and nowhere else", () => {
    const shouted = path.join(base.toUpperCase(), "nested");
    expect(isSameOrInsidePath(shouted, base, "darwin")).toBe(true);
    expect(isSameOrInsidePath(shouted, base, "win32")).toBe(true);
    expect(isSameOrInsidePath(shouted, base, "linux")).toBe(false);
  });
});
