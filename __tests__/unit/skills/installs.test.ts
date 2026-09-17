import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Skill } from "@/mcp/skills/types";

const enabled: Skill[] = [];
const loadEnabledSkills = vi.fn(async () => enabled);
vi.mock("@/mcp/skills/loader", () => ({ loadEnabledSkills: () => loadEnabledSkills() }));
const track = vi.fn();
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: (...a: unknown[]) => track(...a) }));
// The `node:fs` calls libi makes to change a folder's entries, each the real call
// wrapped so a test can rig it — to throw partway through a folder's removal, or to
// refuse writes in one folder (`denyWritesIn`) — on the real filesystem. Every other
// export, and each of these by default, is the untouched original.
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal<typeof import("node:fs")>()) as typeof import("node:fs") & { default: typeof import("node:fs") };
  const rigged = {
    rmSync: vi.fn(actual.rmSync),
    rmdirSync: vi.fn(actual.rmdirSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
  };
  return { ...actual, ...rigged, default: { ...actual.default, ...rigged } };
});

import { eq } from "drizzle-orm";
import { getDb, migrateDatabase, resetDbClient } from "@/lib/db/client";
import { skillInstalls } from "@/lib/db/schema";
import { serverLogger } from "@/lib/logger";
import {
  SkillInstallError,
  addSkillInstall,
  listSkillInstalls,
  ownAgentDirDialects,
  ownAgentDirWriteOptions,
  removeSkillInstall,
  shortInstallError,
  syncOwnAgentDir,
  syncSkillInstalls,
  userSkillsDirs,
  validateInstallFolder,
} from "@/mcp/skills/installs";
import { managedSkillNames, writeSkillsToRoot } from "@/mcp/skills/writer";
import { syncSkillsToWorkspace } from "@/mcp/skills/sync-workspace";

/** True when the temp dir's file system tells `x` from `X`. */
const caseSensitiveFs = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "installs-case-"));
  try {
    return !fs.existsSync(path.join(path.dirname(probe), path.basename(probe).toUpperCase()));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();
const isRoot = process.getuid?.() === 0;

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const RIGGED = ["rmSync", "rmdirSync", "unlinkSync", "mkdirSync", "writeFileSync", "renameSync", "openSync", "closeSync"] as const;
type Rigged = (typeof RIGGED)[number];
const rig = (name: Rigged) => vi.mocked(fs[name] as (...args: unknown[]) => unknown);

/** Every rigged `node:fs` call back to the real one, any queued one-off implementation dropped. */
function unrigFs(): void {
  for (const name of RIGGED) {
    rig(name).mockReset();
    rig(name).mockImplementation(actualFs[name] as (...args: unknown[]) => unknown);
  }
}

/**
 * Refuse, with `code`, every change to an entry directly inside `dir`: creating, writing,
 * renaming or removing one, or creating a folder that has to go inside `dir`. That is what a
 * folder libi may not write to does — a permission mode on POSIX, a deny ACL on Windows, where
 * `chmod` on a folder changes nothing — rigged at the `node:fs` calls libi makes, so it holds
 * on every platform and for root. Returns the undo.
 */
function denyWritesIn(dir: string, code = "EACCES"): () => void {
  const refuse = (op: string): never => {
    throw Object.assign(new Error(`${code}: permission denied, ${op}`), { code });
  };
  const directlyIn = (p: unknown) => typeof p !== "number" && path.dirname(path.resolve(String(p))) === dir;
  const createsIn = (p: unknown) => {
    if (typeof p === "number") return false;
    const rel = path.relative(dir, path.resolve(String(p)));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return !actualFs.existsSync(path.join(dir, rel.split(path.sep)[0]));
  };
  const writeFlag = (flags: unknown) => typeof flags === "string" && /[wax+]/.test(flags);
  const call = (name: Rigged, args: unknown[]) => (actualFs[name] as (...a: unknown[]) => unknown)(...args);
  for (const name of ["rmSync", "rmdirSync", "unlinkSync", "writeFileSync"] as const) {
    rig(name).mockImplementation((...args: unknown[]) => (directlyIn(args[0]) ? refuse(name) : call(name, args)));
  }
  rig("mkdirSync").mockImplementation((...args: unknown[]) => (createsIn(args[0]) ? refuse("mkdir") : call("mkdirSync", args)));
  rig("renameSync").mockImplementation((...args: unknown[]) =>
    directlyIn(args[0]) || directlyIn(args[1]) ? refuse("rename") : call("renameSync", args),
  );
  rig("openSync").mockImplementation((...args: unknown[]) =>
    directlyIn(args[0]) && writeFlag(args[1]) ? refuse("open") : call("openSync", args),
  );
  return unrigFs;
}

/** Rows as `[agentId, scope, folderPath]`, sorted — the level each agent stands at. */
function levels(): string[][] {
  return getDb()
    .select()
    .from(skillInstalls)
    .all()
    .map((r) => [r.agentId, r.scope, r.folderPath])
    .sort();
}

function skill(name: string): Skill {
  return {
    id: name, name, description: `${name} skill`, source: "bundled", enabled: true,
    body: `---\nname: ${name}\ndescription: ${name} skill\n---\n${name} body\n`,
    frontmatter: { name, description: `${name} skill` }, supportingFiles: [], tags: [],
  };
}

let scratch: string;
let home: string;
let libiHome: string;
let project: string;

beforeEach(() => {
  // The native call, as the product resolves folders: it answers the on-disk letter case (`C:\Windows\Temp`
  // for a TEMP spelled `TEMP`), which the JS call keeps as typed.
  scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "installs-")));
  home = path.join(scratch, "home");
  libiHome = path.join(scratch, "libi-home");
  project = path.join(scratch, "project");
  for (const d of [home, libiHome, project, path.join(libiHome, "agent")]) fs.mkdirSync(d, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("LIBI_HOME", libiHome);
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  // A server process with the user's environment, whatever launched the test run.
  vi.stubEnv("LIBI_SHELL_ENV", undefined);
  vi.stubEnv("LIBI_MCP_HEALTH_TOKEN", undefined);
  vi.stubEnv("LIBI_MCP_SUPERVISED", undefined);
  vi.stubEnv("DB_PATH", path.join(scratch, "libi.sqlite"));
  resetDbClient();
  migrateDatabase(path.join(scratch, "libi.sqlite"));
  enabled.splice(0, enabled.length, skill("alpha"), skill("beta"));
  loadEnabledSkills.mockClear();
  track.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  unrigFs();
  resetDbClient();
  vi.unstubAllEnvs();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("validateInstallFolder", () => {
  const ctx = () => ({ homedir: home, libiHome });
  it("accepts a writable folder and answers its realpath; expands ~", () => {
    const link = path.join(scratch, "link");
    fs.symlinkSync(project, link);
    expect(validateInstallFolder(link, ctx())).toEqual({ ok: true, realPath: project });
    fs.mkdirSync(path.join(home, "work"));
    expect(validateInstallFolder("~/work", ctx())).toEqual({ ok: true, realPath: path.join(home, "work") });
  });
  it("refuses relative, missing, file, home, root and libi-home paths with the right code", () => {
    fs.writeFileSync(path.join(scratch, "file.txt"), "x");
    const code = (p: string) => { const v = validateInstallFolder(p, ctx()); return v.ok ? "ok" : v.code; };
    expect(code("relative/dir")).toBe("not_absolute");
    expect(code(path.join(scratch, "missing"))).toBe("not_found");
    expect(code(path.join(scratch, "file.txt"))).toBe("not_directory");
    expect(code(home)).toBe("refused_home");
    expect(code("~")).toBe("refused_home");
    expect(code(path.parse(scratch).root)).toBe("refused_root");
    expect(code(libiHome)).toBe("refused_libi_home");
    expect(code(path.join(libiHome, "agent"))).toBe("refused_libi_home");
    const v = validateInstallFolder(home, ctx());
    expect(!v.ok && v.message).toBe("That's your home folder. To install libi's skills for every folder, choose Every folder.");
  });
  it.skipIf(caseSensitiveFs)("on a case-insensitive disk, a differently-cased path resolves to the on-disk name", async () => {
    const shouted = project.replace(/project$/, "PROJECT");
    expect(validateInstallFolder(shouted, ctx())).toEqual({ ok: true, realPath: project });
    expect(validateInstallFolder(home.replace(/home$/, "HOME"), ctx())).toMatchObject({ ok: false, code: "refused_home" });
    const first = await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: project, source: "ui" });
    const second = await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: shouted, source: "ui" });
    expect(second.id).toBe(first.id);
  });
  it("refuses a folder whose agent's own skills dir, or its parent, is a link — and only for that agent", async () => {
    const elsewhere = path.join(scratch, "elsewhere");
    fs.mkdirSync(elsewhere);
    const message = "libi won't write or remove skills through a linked skills folder.";
    const cases: Array<[rel: string, refused: "claude-code" | "codex", allowed: "claude-code" | "codex", allowedRoot: string]> = [
      [".claude", "claude-code", "codex", path.join(".agents", "skills")],
      [path.join(".claude", "skills"), "claude-code", "codex", path.join(".agents", "skills")],
      [".agents", "codex", "claude-code", path.join(".claude", "skills")],
      [path.join(".agents", "skills"), "codex", "claude-code", path.join(".claude", "skills")],
    ];
    for (const [i, [rel, refused, allowed, allowedRoot]] of cases.entries()) {
      const folder = path.join(scratch, `linked-${i}`);
      fs.mkdirSync(path.dirname(path.join(folder, rel)), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(folder, rel));
      await expect(
        addSkillInstall({ agentId: refused, scope: "folder", folderPath: folder, source: "ui" }),
      ).rejects.toMatchObject({ code: "not_writable", message });
      // The other agent's skills dir is a real folder, so its install goes ahead.
      const view = await addSkillInstall({ agentId: allowed, scope: "folder", folderPath: folder, source: "ui" });
      expect(view).toMatchObject({ status: "up-to-date", error: null });
      expect(managedSkillNames(path.join(folder, allowedRoot))).toEqual(["alpha", "beta"]);
    }
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(levels().map(([agentId]) => agentId)).toEqual(["claude-code", "claude-code", "codex", "codex"]);
  });
  it("refuses a folder a real write is denied in, whatever its permission bits say (a deny ACL on Windows)", () => {
    for (const code of ["EACCES", "EPERM", "EROFS"]) {
      const denied = path.join(scratch, `denied-${code}`);
      fs.mkdirSync(denied);
      const undo = denyWritesIn(denied, code);
      try {
        expect(validateInstallFolder(denied, ctx())).toEqual({ ok: false, code: "not_writable", message: "libi can't write to that folder." });
      } finally {
        undo();
      }
      expect(fs.readdirSync(denied)).toEqual([]);
    }
  });
  it("probes with one new file directly inside the folder, never an existing one, and leaves nothing behind", () => {
    rig("openSync").mockClear();
    expect(validateInstallFolder(project, ctx())).toEqual({ ok: true, realPath: project });
    const probes = rig("openSync").mock.calls.filter(([p]) => path.dirname(String(p)) === project);
    expect(probes).toHaveLength(1);
    expect(path.basename(String(probes[0][0]))).toMatch(/^\.libi-write-probe-[0-9a-f]+$/);
    expect(probes[0][1]).toBe("wx");
    expect(fs.readdirSync(project)).toEqual([]);
  });
  it("removes its probe file even when closing it fails, and refuses the folder", () => {
    rig("closeSync").mockImplementationOnce((fd: unknown) => {
      actualFs.closeSync(fd as number);
      throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
    });
    expect(validateInstallFolder(project, ctx())).toMatchObject({ ok: false, code: "not_writable" });
    expect(fs.readdirSync(project)).toEqual([]);
  });
  it("a probe file left behind by a denied delete is removed the next time the folder is probed; a link or folder with that name stays", () => {
    // Windows can allow creating a file but deny deleting it: the probe refuses the folder and its file stays.
    rig("unlinkSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
    });
    expect(validateInstallFolder(project, ctx())).toMatchObject({ ok: false, code: "not_writable" });
    const leftovers = fs.readdirSync(project);
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toMatch(/^\.libi-write-probe-[0-9a-f]{16}$/);

    const outside = path.join(scratch, "outside.txt");
    fs.writeFileSync(outside, "keep");
    const linkName = ".libi-write-probe-aaaaaaaaaaaaaaaa";
    const dirName = ".libi-write-probe-bbbbbbbbbbbbbbbb";
    fs.symlinkSync(outside, path.join(project, linkName));
    fs.mkdirSync(path.join(project, dirName));

    expect(validateInstallFolder(project, ctx())).toEqual({ ok: true, realPath: project });
    expect(fs.readdirSync(project).sort()).toEqual([linkName, dirName].sort());
    expect(fs.lstatSync(path.join(project, linkName)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, "utf-8")).toBe("keep");
  });
  it("a leftover probe file that can't be removed does not change the verdict", () => {
    const leftover = path.join(project, ".libi-write-probe-cccccccccccccccc");
    fs.writeFileSync(leftover, "");
    rig("unlinkSync").mockImplementation((...args: unknown[]) => {
      if (String(args[0]) === leftover) throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
      return actualFs.unlinkSync(args[0] as string);
    });
    expect(validateInstallFolder(project, ctx())).toEqual({ ok: true, realPath: project });
    expect(fs.readdirSync(project)).toEqual([path.basename(leftover)]);
  });
  // Real permission bits, beside the rigged denial above. Skipped on Windows, where a folder's mode
  // does not restrict writing (the rigged denial covers it there), and for root, who writes anywhere.
  it.skipIf(isRoot || process.platform === "win32")("refuses a folder whose permission bits deny writing", () => {
    const ro = path.join(scratch, "ro");
    fs.mkdirSync(ro, { mode: 0o500 });
    const v = validateInstallFolder(ro, ctx());
    expect(!v.ok && v.code).toBe("not_writable");
  });
});

describe("addSkillInstall / listSkillInstalls / removeSkillInstall", () => {
  it("a folder install writes the agent's dialect now, records the row, and reads Up to date", async () => {
    const view = await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    expect(view).toMatchObject({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui", status: "up-to-date", error: null, skippedNames: [], installedCount: 2 });
    expect(view.path).toBe(path.join(project, ".claude", "skills"));
    expect(typeof view.lastSyncedAt).toBe("string");
    expect(fs.existsSync(path.join(project, ".claude", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".agents", "skills"))).toBe(false);
    expect((await listSkillInstalls()).map((v) => v.id)).toEqual([view.id]);
    expect(track).toHaveBeenCalledWith("skills_install_added", { agent: "claude", scope: "folder", source: "ui" });
  });

  it("adding the same folder again (through a symlink, or with a trailing slash) returns the existing row", async () => {
    const first = await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: project, source: "cli" });
    const link = path.join(scratch, "link");
    fs.symlinkSync(project, link);
    const second = await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: link + path.sep, source: "ui" });
    expect(second.id).toBe(first.id);
    expect(second.source).toBe("cli");
    expect(await listSkillInstalls()).toHaveLength(1);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it("a user-level install writes the agent's user dir (CLAUDE_CONFIG_DIR/skills for Claude, ~/.agents/skills for Codex)", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg"));
    const claude = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
    expect(claude.path).toBe(path.join(scratch, "cfg", "skills"));
    expect(claude.folderPath).toBeNull();
    expect(fs.existsSync(path.join(scratch, "cfg", "skills", "beta", "SKILL.md"))).toBe(true);
    const codex = await addSkillInstall({ agentId: "codex", scope: "user", source: "cli" });
    expect(codex.path).toBe(path.join(home, ".agents", "skills"));
    expect(userSkillsDirs()).toEqual({ "claude-code": path.join(scratch, "cfg", "skills"), codex: "~/.agents/skills" });
    expect(track).toHaveBeenCalledWith("skills_install_added", { agent: "codex", scope: "user", source: "cli" });
  });

  it("skips a same-name skill that is not libi's and reports it", async () => {
    fs.mkdirSync(path.join(project, ".agents", "skills", "alpha"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agents", "skills", "alpha", "SKILL.md"), "mine");
    const view = await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: project, source: "ui" });
    expect(view.skippedNames).toEqual(["alpha"]);
    expect(view.installedCount).toBe(1);
    expect(fs.readFileSync(path.join(project, ".agents", "skills", "alpha", "SKILL.md"), "utf-8")).toBe("mine");
  });

  it("rejects an unknown agent and an invalid folder with a typed error", async () => {
    await expect(addSkillInstall({ agentId: "gemini" as never, scope: "user", source: "ui" })).rejects.toMatchObject({ code: "unknown_agent" });
    await expect(addSkillInstall({ agentId: "codex", scope: "folder", folderPath: "nope", source: "ui" })).rejects.toBeInstanceOf(SkillInstallError);
    await expect(addSkillInstall({ agentId: "codex", scope: "folder", folderPath: home, source: "ui" })).rejects.toMatchObject({ code: "refused_home" });
    expect(await listSkillInstalls()).toEqual([]);
  });

  it("rejects a scope or source outside the known set with a typed error, so analytics params stay bounded", async () => {
    await expect(addSkillInstall({ agentId: "codex", scope: "global", source: "ui" } as never)).rejects.toBeInstanceOf(SkillInstallError);
    await expect(addSkillInstall({ agentId: "codex", scope: "user", source: "api" } as never)).rejects.toBeInstanceOf(SkillInstallError);
    await expect(addSkillInstall({ agentId: "codex", scope: "folder", folderPath: project, source: "http" } as never)).rejects.toBeInstanceOf(SkillInstallError);
    await expect(addSkillInstall({ agentId: "__proto__" as never, scope: "user", source: "ui" })).rejects.toMatchObject({ code: "unknown_agent" });
    expect(levels()).toEqual([]);
    expect(fs.existsSync(path.join(home, ".agents"))).toBe(false);
    expect(track).not.toHaveBeenCalled();
  });

  it("fires skills_install_added only when the first write succeeded", async () => {
    fs.mkdirSync(path.join(project, ".claude"));
    const allowWrites = denyWritesIn(path.join(project, ".claude"));
    try {
      const view = await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
      expect(view).toMatchObject({ status: "error", error: "permission denied" });
      expect(track).not.toHaveBeenCalled();
    } finally {
      allowWrites();
    }
    await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: project, source: "cli" });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("skills_install_added", { agent: "codex", scope: "folder", source: "cli" });
  });

  it("remove deletes libi's files first, then the row; unknown id is null", async () => {
    const view = await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    fs.mkdirSync(path.join(project, ".claude", "skills", "theirs"));
    expect(await removeSkillInstall(view.id)).toEqual({ removed: 2 });
    expect(fs.existsSync(path.join(project, ".claude", "skills", "alpha"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "theirs"))).toBe(true);
    expect(await listSkillInstalls()).toEqual([]);
    expect(await removeSkillInstall("nope")).toBeNull();
  });

  it("remove on an install whose manifest is unreadable throws, keeps the row, and leaves libi's folders untouched", async () => {
    const view = await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    fs.writeFileSync(path.join(project, ".claude", "skills", ".libi-managed.json"), "not json");
    await expect(removeSkillInstall(view.id)).rejects.toThrow(
      "libi's skills manifest (.libi-managed.json) is unreadable — delete it and libi's skill folders to remove them.",
    );
    expect((await listSkillInstalls()).map((v) => v.id)).toEqual([view.id]);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "beta", "SKILL.md"))).toBe(true);
  });

  describe("a folder install is never removed through a link", () => {
    const LINKED = "libi won't write or remove skills through a linked skills folder.";
    /** Another root holding libi's skills and manifest — another project's install, or a shared skills dir. */
    let shared: string;
    beforeEach(() => {
      shared = path.join(scratch, "shared", ".claude", "skills");
      writeSkillsToRoot(shared, enabled, { external: true });
    });
    const expectSharedIntact = () => {
      expect(managedSkillNames(shared)).toEqual(["alpha", "beta"]);
      expect(fs.existsSync(path.join(shared, ".libi-managed.json"))).toBe(true);
      expect(fs.existsSync(path.join(shared, "alpha", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(shared, "beta", "SKILL.md"))).toBe(true);
    };
    const storedError = (id: string) => getDb().select().from(skillInstalls).where(eq(skillInstalls.id, id)).get()?.lastError;

    it("Remove refuses when the skills dir, its parent, or the folder itself became a link: nothing removed at the target, the row kept with why", async () => {
      const warn = vi.spyOn(serverLogger, "warn");
      const swaps: Array<(folder: string) => void> = [
        (folder) => {
          fs.rmSync(path.join(folder, ".claude", "skills"), { recursive: true });
          fs.symlinkSync(shared, path.join(folder, ".claude", "skills"), "dir");
        },
        (folder) => {
          fs.rmSync(path.join(folder, ".claude"), { recursive: true });
          fs.symlinkSync(path.dirname(shared), path.join(folder, ".claude"), "dir");
        },
        (folder) => {
          fs.rmSync(folder, { recursive: true });
          fs.symlinkSync(path.join(scratch, "shared"), folder, "dir");
        },
      ];
      for (const [i, swap] of swaps.entries()) {
        const folder = path.join(scratch, `linked-${i}`);
        fs.mkdirSync(folder);
        const view = await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: folder, source: "ui" });
        swap(folder);
        await expect(removeSkillInstall(view.id)).rejects.toMatchObject({ name: "SkillInstallError", code: "not_writable", message: LINKED });
        expectSharedIntact();
        expect(storedError(view.id)).toBe(LINKED);
        expect((await listSkillInstalls()).find((v) => v.id === view.id)).toMatchObject({ status: "error", error: LINKED });
      }
      const refused = warn.mock.calls.map((c) => c[0] as { op?: string }).filter((o) => o?.op === "install_remove_refused");
      expect(refused).toEqual(
        Array(3).fill({ tag: "skills", op: "install_remove_refused", agentId: "claude-code", scope: "folder", reason: "linked_skills_folder" }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(scratch);
    });

    it("Every folder does not remove a folder install through its linked skills dir: the add backs out and the target keeps libi's skills", async () => {
      const view = await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
      fs.rmSync(path.join(project, ".claude", "skills"), { recursive: true });
      fs.symlinkSync(shared, path.join(project, ".claude", "skills"), "dir");
      const err = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SkillInstallError);
      expect((err as Error).message).toContain(LINKED);
      expectSharedIntact();
      expect(levels()).toEqual([["claude-code", "folder", project]]);
      expect(storedError(view.id)).toBe(LINKED);
      expect(managedSkillNames(path.join(home, ".claude", "skills"))).toEqual([]);
    });
  });

  it("a recorded folder that disappeared reads Folder not found, is never recreated, and can be removed", async () => {
    const view = await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "cli" });
    fs.rmSync(project, { recursive: true, force: true });
    await syncSkillInstalls("test");
    const [row] = await listSkillInstalls();
    expect(row).toMatchObject({ id: view.id, status: "folder-not-found", error: null, installedCount: 0 });
    expect(fs.existsSync(project)).toBe(false);
    expect(await removeSkillInstall(view.id)).toEqual({ removed: 0 });
    expect(await listSkillInstalls()).toEqual([]);
  });

  it("lists installs in the order they were added, even within the same second", async () => {
    const folders = ["a", "b", "c", "d", "e"].map((n) => path.join(scratch, n));
    const ids: string[] = [];
    for (const f of folders) {
      fs.mkdirSync(f);
      ids.push((await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: f, source: "ui" })).id);
    }
    expect((await listSkillInstalls()).map((v) => v.id)).toEqual(ids);
  });
});

describe("one level per agent", () => {
  it("a folder install is refused while the agent has a user-level install", async () => {
    await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
    await expect(addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" })).rejects.toMatchObject({
      code: "user_level_installed",
      message: "Skills are installed for every folder, so every folder already has them.",
    });
    // The other agent is unaffected.
    await expect(addSkillInstall({ agentId: "codex", scope: "folder", folderPath: project, source: "ui" })).resolves.toMatchObject({ status: "up-to-date" });
  });

  it("a user-level install removes that agent's folder installs — files and rows — and only that agent's", async () => {
    const other = path.join(scratch, "other");
    fs.mkdirSync(other);
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: other, source: "cli" });
    const codexRow = await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: project, source: "ui" });
    await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
    const rows = await listSkillInstalls();
    expect(rows.map((r) => [r.agentId, r.scope]).sort()).toEqual([["claude-code", "user"], ["codex", "folder"]]);
    expect(rows.find((r) => r.agentId === "codex")?.id).toBe(codexRow.id);
    expect(fs.existsSync(path.join(project, ".claude", "skills"))).toBe(false);
    expect(fs.existsSync(path.join(other, ".claude", "skills"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".agents", "skills", "alpha"))).toBe(true);
  });

  it("a user-level add whose user dir is not writable keeps every folder install and leaves no user row", async () => {
    const other = path.join(scratch, "other");
    fs.mkdirSync(other);
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: other, source: "cli" });
    track.mockClear();
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir);
    const allowWrites = denyWritesIn(claudeDir);
    try {
      const err = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SkillInstallError);
      expect(err).toMatchObject({ code: "not_writable" });
      expect((err as Error).message).toContain("~/.claude/skills");
    } finally {
      allowWrites();
    }
    expect(levels()).toEqual([["claude-code", "folder", other], ["claude-code", "folder", project]]);
    expect(managedSkillNames(path.join(project, ".claude", "skills"))).toEqual(["alpha", "beta"]);
    expect(managedSkillNames(path.join(other, ".claude", "skills"))).toEqual(["alpha", "beta"]);
    expect(ownAgentDirDialects()).toEqual([".claude/skills", ".agents/skills"]);
    expect(fs.existsSync(path.join(libiHome, "agent", ".claude", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(track).not.toHaveBeenCalled();
  });

  it("a folder removal that fails during a user-level add is a typed error and leaves the agent at one level", async () => {
    const other = path.join(scratch, "other");
    fs.mkdirSync(other);
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: other, source: "cli" });
    track.mockClear();
    const stuck = path.join(other, ".claude", "skills");
    const allowWrites = denyWritesIn(stuck);
    try {
      const err = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SkillInstallError);
      expect((err as Error).message).toContain(other);
    } finally {
      allowWrites();
    }
    // No user level; both folders still have libi's skills, and both are still recorded.
    expect(levels()).toEqual([["claude-code", "folder", other], ["claude-code", "folder", project]]);
    expect(managedSkillNames(path.join(home, ".claude", "skills"))).toEqual([]);
    expect(managedSkillNames(path.join(project, ".claude", "skills"))).toEqual(["alpha", "beta"]);
    expect(managedSkillNames(stuck)).toEqual(["alpha", "beta"]);
    expect(ownAgentDirDialects()).toEqual([".claude/skills", ".agents/skills"]);
    expect(fs.existsSync(path.join(libiHome, "agent", ".claude", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(track).not.toHaveBeenCalled();
    const views = await listSkillInstalls();
    expect(views.map((v) => v.status)).toEqual(["up-to-date", "up-to-date"]);
  });

  it("a folder removal that fails with EACCES ends the reason with a period before 'Nothing'", async () => {
    const other = path.join(scratch, "other");
    fs.mkdirSync(other);
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: other, source: "cli" });
    track.mockClear();
    const stuck = path.join(other, ".claude", "skills");
    const allowWrites = denyWritesIn(stuck, "EACCES");
    try {
      const err = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SkillInstallError);
      expect((err as Error).message).toBe(
        `libi couldn't remove its skills from ${stuck}: permission denied. Nothing was installed for every folder.`,
      );
    } finally {
      allowWrites();
    }
  });

  it("a folder removal that fails via linked skills folder ends the reason with a period before 'Nothing'", async () => {
    const other = path.join(scratch, "other");
    fs.mkdirSync(other);
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: other, source: "cli" });
    // Set up a shared skills dir to symlink to
    const shared = path.join(scratch, "shared", ".claude", "skills");
    writeSkillsToRoot(shared, enabled, { external: true });
    // Make the other folder's skills dir a symlink so removal will fail with the linked folder message
    fs.rmSync(path.join(other, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(shared, path.join(other, ".claude", "skills"), "dir");
    track.mockClear();
    const err = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillInstallError);
    expect((err as Error).message).toBe(
      `libi couldn't remove its skills from ${path.join(other, ".claude", "skills")}: libi won't write or remove skills through a linked skills folder. Nothing was installed for every folder.`,
    );
  });

  it.skipIf(isRoot)("a folder removal that deletes only some of a folder's skill dirs before throwing restores that folder in full", async () => {
    const other = path.join(scratch, "other");
    fs.mkdirSync(other);
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: other, source: "cli" });
    track.mockClear();
    const otherRoot = path.join(other, ".claude", "skills");
    const { rmSync: realRmSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    // The first rmSync under "other"'s root (whichever skill dir it hits first)
    // succeeds for real, so this folder loses one of its two skill dirs before
    // the second call throws — a genuine partial removal, deterministic
    // regardless of directory-listing order.
    let otherCalls = 0;
    const rmSyncMock = fs.rmSync as unknown as { mockImplementation: (fn: typeof fs.rmSync) => void };
    rmSyncMock.mockImplementation(((p: fs.PathLike, opts?: fs.RmOptions) => {
      const target = String(p);
      if (target === otherRoot || target.startsWith(otherRoot + path.sep)) {
        otherCalls++;
        if (otherCalls > 1) throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" });
      }
      return realRmSync(p, opts);
    }) as typeof fs.rmSync);
    try {
      const err = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SkillInstallError);
      expect((err as Error).message).toContain(other);
    } finally {
      rmSyncMock.mockImplementation(realRmSync);
    }
    // Both folders keep their rows, and "other" has every skill back even
    // though one of its two dirs was actually deleted before the throw.
    expect(levels()).toEqual([["claude-code", "folder", other], ["claude-code", "folder", project]]);
    expect(managedSkillNames(path.join(project, ".claude", "skills"))).toEqual(["alpha", "beta"]);
    expect(managedSkillNames(otherRoot)).toEqual(["alpha", "beta"]);
    expect(fs.existsSync(path.join(otherRoot, "alpha", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(otherRoot, "beta", "SKILL.md"))).toBe(true);
    expect(track).not.toHaveBeenCalled();
    const views = await listSkillInstalls();
    expect(views.map((v) => v.status)).toEqual(["up-to-date", "up-to-date"]);
  });

  it("a user-level add whose folder-removal step hits an unreadable manifest backs out the user level and keeps that folder's skills", async () => {
    const other = path.join(scratch, "other");
    fs.mkdirSync(other);
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: other, source: "cli" });
    track.mockClear();
    fs.writeFileSync(path.join(other, ".claude", "skills", ".libi-managed.json"), "not json");
    const err = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillInstallError);
    expect((err as Error).message).toContain(other);
    // No user level; both folders still recorded, and "other"'s skills are untouched on disk.
    expect(levels()).toEqual([["claude-code", "folder", other], ["claude-code", "folder", project]]);
    expect(managedSkillNames(path.join(home, ".claude", "skills"))).toEqual([]);
    expect(managedSkillNames(path.join(project, ".claude", "skills"))).toEqual(["alpha", "beta"]);
    expect(fs.existsSync(path.join(other, ".claude", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(other, ".claude", "skills", "beta", "SKILL.md"))).toBe(true);
    expect(ownAgentDirDialects()).toEqual([".claude/skills", ".agents/skills"]);
    expect(track).not.toHaveBeenCalled();
    // The failed removal's catch writes the row back through writeRow, which hits the
    // same unreadable manifest and records the write-side message as this row's error.
    const otherView = (await listSkillInstalls()).find((v) => v.folderPath === other);
    expect(otherView).toMatchObject({
      status: "error",
      error: "libi's skills manifest (.libi-managed.json) is unreadable — delete it and libi's skill folders to reinstall them.",
    });
  });

  it("restores a folder's row after a backed-out user-level add without recreating it, when the folder vanished meanwhile", async () => {
    const other = path.join(scratch, "other");
    fs.mkdirSync(other);
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: other, source: "cli" });
    track.mockClear();
    const otherRoot = path.join(other, ".claude", "skills");
    const { rmSync: realRmSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    // "project" (the folder the back-out will try to restore) is removed
    // first and succeeds. Then "other"'s removal fails, and as a side effect
    // of that very failure "project" disappears from disk entirely — standing
    // in for the user deleting it by hand in the gap between its own removal
    // and the back-out's restore.
    const rmSyncMock = fs.rmSync as unknown as { mockImplementation: (fn: typeof fs.rmSync) => void };
    rmSyncMock.mockImplementation(((p: fs.PathLike, opts?: fs.RmOptions) => {
      const target = String(p);
      if (target === otherRoot || target.startsWith(otherRoot + path.sep)) {
        realRmSync(project, { recursive: true, force: true });
        throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES" });
      }
      return realRmSync(p, opts);
    }) as typeof fs.rmSync);
    try {
      const err = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SkillInstallError);
    } finally {
      rmSyncMock.mockImplementation(realRmSync);
    }
    expect(fs.existsSync(project)).toBe(false);
    expect(levels()).toEqual([["claude-code", "folder", other], ["claude-code", "folder", project]]);
    const views = await listSkillInstalls();
    const projectView = views.find((v) => v.folderPath === project);
    expect(projectView).toMatchObject({ status: "folder-not-found", installedCount: 0 });
    expect(fs.existsSync(project)).toBe(false);
    const otherView = views.find((v) => v.folderPath === other);
    expect(otherView).toMatchObject({ status: "up-to-date" });
    expect(track).not.toHaveBeenCalled();
  });

  it("a user-level add whose row a concurrent backout removed while it loaded skills throws, not a stale view", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    loadEnabledSkills.mockImplementationOnce(async () => { await gate; return enabled; });
    const adding = addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
    const result = adding.catch((e: unknown) => e);
    await vi.waitFor(() => expect(loadEnabledSkills).toHaveBeenCalledTimes(1));
    // Stand in for a concurrent add of the same user level backing out and
    // deleting the row they shared while this one was still loading skills.
    const [row] = await listSkillInstalls();
    getDb().delete(skillInstalls).where(eq(skillInstalls.id, row.id)).run();
    release();
    const err = await result;
    expect(err).toBeInstanceOf(SkillInstallError);
    expect(err).toMatchObject({ code: "not_writable", message: "libi's skills weren't installed for every folder. Try again." });
    expect(levels()).toEqual([]);
    expect(track).not.toHaveBeenCalled();
  });

  it("a folder install recorded while a user-level add is still writing is removed by that add", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    loadEnabledSkills.mockImplementationOnce(async () => { await gate; return enabled; });
    const adding = addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
    await vi.waitFor(() => expect(loadEnabledSkills).toHaveBeenCalledTimes(1));
    // Another writer (libi connect in its own process) records a folder install meanwhile.
    getDb().insert(skillInstalls).values({ agentId: "claude-code", scope: "folder", folderPath: project, source: "cli" }).run();
    writeSkillsToRoot(path.join(project, ".claude", "skills"), enabled, { external: true });
    release();
    await expect(adding).resolves.toMatchObject({ scope: "user", status: "up-to-date" });
    expect(levels()).toEqual([["claude-code", "user", ""]]);
    expect(fs.existsSync(path.join(project, ".claude", "skills"))).toBe(false);
  });

  it("a folder add re-checks for a user-level install after recording itself, and backs out if one appeared", async () => {
    const db = getDb();
    const realInsert = db.insert.bind(db);
    // A user-level install lands between the folder add's check and its insert.
    vi.spyOn(db, "insert").mockImplementationOnce(((table: typeof skillInstalls) => {
      realInsert(skillInstalls).values({ agentId: "claude-code", scope: "user", source: "cli" }).run();
      return realInsert(table);
    }) as typeof db.insert);
    await expect(addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" })).rejects.toMatchObject({
      code: "user_level_installed",
    });
    expect(levels()).toEqual([["claude-code", "user", ""]]);
    expect(fs.existsSync(path.join(project, ".claude", "skills"))).toBe(false);
    expect(track).not.toHaveBeenCalled();
  });

  it("a folder add whose row a user-level add removed while it was loading skills writes nothing and says why", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    loadEnabledSkills.mockImplementationOnce(async () => { await gate; return enabled; });
    const folderAdd = addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    const folderResult = folderAdd.catch((e: unknown) => e);
    await vi.waitFor(() => expect(loadEnabledSkills).toHaveBeenCalledTimes(1));
    await addSkillInstall({ agentId: "claude-code", scope: "user", source: "cli" });
    release();
    expect(await folderResult).toMatchObject({ code: "user_level_installed" });
    expect(levels()).toEqual([["claude-code", "user", ""]]);
    expect(fs.existsSync(path.join(project, ".claude", "skills"))).toBe(false);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("skills_install_added", { agent: "claude", scope: "user", source: "cli" });
  });

  it("a folder add whose row was deleted while it loaded skills (not by a user-level add) throws, not a view of a deleted install", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    loadEnabledSkills.mockImplementationOnce(async () => { await gate; return enabled; });
    const adding = addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    const result = adding.catch((e: unknown) => e);
    await vi.waitFor(() => expect(loadEnabledSkills).toHaveBeenCalledTimes(1));
    // Stand in for the DELETE route removing this install while it was loading skills.
    const [row] = await listSkillInstalls();
    getDb().delete(skillInstalls).where(eq(skillInstalls.id, row.id)).run();
    release();
    const err = await result;
    expect(err).toBeInstanceOf(SkillInstallError);
    expect(err).toMatchObject({ code: "not_writable", message: "That install was removed while libi was installing it." });
    expect(levels()).toEqual([]);
    expect(fs.existsSync(path.join(project, ".claude", "skills"))).toBe(false);
    expect(track).not.toHaveBeenCalled();
  });

  it("a failure writing libi's own agent dir is logged, and the user-level add still succeeds", async () => {
    const warn = vi.spyOn(serverLogger, "warn");
    const agentDir = path.join(libiHome, "agent");
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.writeFileSync(agentDir, "not a folder");
    const view = await addSkillInstall({ agentId: "codex", scope: "user", source: "ui" });
    expect(view).toMatchObject({ scope: "user", status: "up-to-date", installedCount: 2 });
    expect(levels()).toEqual([["codex", "user", ""]]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "skills", op: "own_agent_dir_failed" }), "skills.own_agent_dir_failed");
    expect(track).toHaveBeenCalledWith("skills_install_added", { agent: "codex", scope: "user", source: "ui" });
  });

  it("libi's own agent dir drops the agent's dialect while a user-level install exists, and restores it on removal", async () => {
    const agentDir = path.join(libiHome, "agent");
    expect(ownAgentDirDialects()).toEqual([".claude/skills", ".agents/skills"]);
    const view = await addSkillInstall({ agentId: "codex", scope: "user", source: "ui" });
    expect(ownAgentDirDialects()).toEqual([".claude/skills"]);
    expect(fs.existsSync(path.join(agentDir, ".claude", "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, ".agents", "skills"))).toBe(false);
    await removeSkillInstall(view.id);
    expect(ownAgentDirDialects()).toEqual([".claude/skills", ".agents/skills"]);
    expect(fs.existsSync(path.join(agentDir, ".agents", "skills", "alpha", "SKILL.md"))).toBe(true);
  });

  it("refuses a user-level add whose root links into libi's own agent dir, and creates nothing", async () => {
    const agentDir = path.join(libiHome, "agent");
    const userRoot = path.join(home, ".agents", "skills");
    fs.mkdirSync(path.join(agentDir, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(path.dirname(userRoot), { recursive: true });
    fs.symlinkSync(path.join(agentDir, ".agents", "skills"), userRoot, "dir");

    await expect(addSkillInstall({ agentId: "codex", scope: "user", source: "ui" })).rejects.toMatchObject({
      code: "linked_to_libi",
      message: "libi's skills folder for every folder links into libi's own agent folder. Remove that link, then install again.",
    });
    expect(levels()).toEqual([]);
    expect(fs.existsSync(path.join(userRoot, ".libi-managed.json"))).toBe(false);
    expect(track).not.toHaveBeenCalled();
  });

  it("an existing user-level row found linked into libi's own agent dir at sync time gets the same error, and is not written through", async () => {
    const agentDir = path.join(libiHome, "agent");
    const userRoot = path.join(home, ".agents", "skills");
    fs.mkdirSync(path.join(agentDir, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(path.dirname(userRoot), { recursive: true });
    fs.symlinkSync(path.join(agentDir, ".agents", "skills"), userRoot, "dir");
    // Stands in for a row that predates this refusal (or one hand-edited into this state).
    getDb().insert(skillInstalls).values({ agentId: "codex", scope: "user", folderPath: "", source: "ui" }).run();

    await syncSkillInstalls("skills-changed");

    const rows = await listSkillInstalls();
    expect(rows).toMatchObject([
      {
        agentId: "codex",
        scope: "user",
        status: "error",
        error: "libi's skills folder for every folder links into libi's own agent folder. Remove that link, then install again.",
      },
    ]);
    expect(managedSkillNames(userRoot)).toEqual([]);
  });

  it("libi's own agent dir linked to the agent's user-level skills dir keeps the user-level install's skills, on every later skill change too", async () => {
    const agentDir = path.join(libiHome, "agent");
    const userRoot = path.join(home, ".agents", "skills");
    fs.mkdirSync(userRoot, { recursive: true });
    fs.mkdirSync(path.join(agentDir, ".agents"), { recursive: true });
    fs.symlinkSync(userRoot, path.join(agentDir, ".agents", "skills"), "dir");

    const view = await addSkillInstall({ agentId: "codex", scope: "user", source: "ui" });
    expect(view).toMatchObject({ scope: "user", status: "up-to-date", installedCount: 2 });
    expect(managedSkillNames(userRoot)).toEqual(["alpha", "beta"]);
    for (let change = 0; change < 2; change++) {
      // The own dir's write alone, before the installs sync that follows a skill change could put anything back.
      await syncOwnAgentDir();
      expect(managedSkillNames(userRoot), `own dir write ${change + 1}`).toEqual(["alpha", "beta"]);
      await syncSkillsToWorkspace();
      expect(managedSkillNames(userRoot), `skill change ${change + 1}`).toEqual(["alpha", "beta"]);
      expect((await listSkillInstalls())[0]).toMatchObject({ id: view.id, status: "up-to-date", installedCount: 2 });
    }
    expect(fs.lstatSync(path.join(agentDir, ".agents", "skills")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(agentDir, ".claude", "skills", "alpha", "SKILL.md"))).toBe(true);
  });

  it("the root a user-level install last wrote is protected too, when this process resolves a different one", async () => {
    const rootA = path.join(scratch, "cfg-a", "skills");
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-a"));
    await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
    expect(managedSkillNames(rootA)).toEqual(["alpha", "beta"]);
    const agentDir = path.join(libiHome, "agent");
    fs.mkdirSync(path.join(agentDir, ".claude"), { recursive: true });
    fs.symlinkSync(rootA, path.join(agentDir, ".claude", "skills"), "dir");
    // An MCP child whose environment names another root keeps writing the recorded one.
    vi.stubEnv("LIBI_MCP_SUPERVISED", "1");
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-b"));
    expect(ownAgentDirWriteOptions().protectedRoots).toEqual(
      expect.arrayContaining([path.join(scratch, "cfg-b", "skills"), path.join(home, ".agents", "skills"), rootA]),
    );
    await syncOwnAgentDir();
    expect(managedSkillNames(rootA)).toEqual(["alpha", "beta"]);
    await syncSkillsToWorkspace();
    expect(managedSkillNames(rootA)).toEqual(["alpha", "beta"]);
    expect(fs.existsSync(path.join(scratch, "cfg-b", "skills"))).toBe(false);
  });
});

describe("syncSkillInstalls", () => {
  it("rewrites every recorded root from one skills load, stores a write failure, and clears it on the next success", async () => {
    const view = await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    await addSkillInstall({ agentId: "codex", scope: "user", source: "ui" });
    enabled.splice(0, enabled.length, skill("gamma"));
    loadEnabledSkills.mockClear();
    await syncSkillInstalls("test");
    expect(loadEnabledSkills).toHaveBeenCalledTimes(1);
    expect(managedSkillNames(path.join(project, ".claude", "skills"))).toEqual(["gamma"]);
    expect(managedSkillNames(path.join(home, ".agents", "skills"))).toEqual(["gamma"]);

    const allowWrites = denyWritesIn(path.join(project, ".claude", "skills"));
    try {
      enabled.splice(0, enabled.length, skill("delta"));
      await syncSkillInstalls("test");
      const failed = (await listSkillInstalls()).find((r) => r.id === view.id)!;
      expect(failed.status).toBe("error");
      expect(failed.error).toBe("permission denied");
    } finally {
      allowWrites();
    }
    await syncSkillInstalls("test");
    const ok = (await listSkillInstalls()).find((r) => r.id === view.id)!;
    expect(ok).toMatchObject({ status: "up-to-date", error: null });
  });

  it("runs one sync at a time and queues exactly one more for requests made meanwhile", async () => {
    await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: project, source: "ui" });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    loadEnabledSkills.mockClear();
    loadEnabledSkills.mockImplementationOnce(async () => { await gate; return enabled; });
    const first = syncSkillInstalls("a");
    const second = syncSkillInstalls("b");
    const third = syncSkillInstalls("c");
    expect(loadEnabledSkills).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second, third]);
    await new Promise((r) => setTimeout(r, 20));
    expect(loadEnabledSkills).toHaveBeenCalledTimes(2);
  });

  it("a request made during a run resolves only after the run that covers it", async () => {
    await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: project, source: "ui" });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    loadEnabledSkills.mockImplementationOnce(async () => { const snapshot = [...enabled]; await gate; return snapshot; });
    const first = syncSkillInstalls("a");
    // The skill set changes while the first run is already loading the old one.
    enabled.splice(0, enabled.length, skill("gamma"));
    const second = syncSkillInstalls("b");
    release();
    await second;
    expect(managedSkillNames(path.join(project, ".agents", "skills"))).toEqual(["gamma"]);
    await first;
  });

  it("a folder install whose skills dir, or its parent, became a link is not written through it, and says why", async () => {
    const message = "libi won't write or remove skills through a linked skills folder.";
    const claudeFolder = path.join(scratch, "claude-folder");
    const codexFolder = path.join(scratch, "codex-folder");
    const claudeElsewhere = path.join(scratch, "claude-elsewhere");
    const codexElsewhere = path.join(scratch, "codex-elsewhere");
    for (const d of [claudeFolder, codexFolder, claudeElsewhere, codexElsewhere]) fs.mkdirSync(d);
    const claude = await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: claudeFolder, source: "ui" });
    const codex = await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: codexFolder, source: "ui" });
    // The user swaps the folders libi wrote for links.
    fs.renameSync(path.join(claudeFolder, ".claude"), path.join(scratch, "claude-moved"));
    fs.symlinkSync(claudeElsewhere, path.join(claudeFolder, ".claude"));
    fs.renameSync(path.join(codexFolder, ".agents", "skills"), path.join(scratch, "codex-moved"));
    fs.symlinkSync(codexElsewhere, path.join(codexFolder, ".agents", "skills"));
    enabled.splice(0, enabled.length, skill("gamma"));
    await syncSkillInstalls("test");
    expect(fs.readdirSync(claudeElsewhere)).toEqual([]);
    expect(fs.readdirSync(codexElsewhere)).toEqual([]);
    const views = await listSkillInstalls();
    expect(views.find((v) => v.id === claude.id)).toMatchObject({ status: "error", error: message });
    expect(views.find((v) => v.id === codex.id)).toMatchObject({ status: "error", error: message });
  });

  it("a folder install whose folder itself became a link is not written through it, and says why", async () => {
    const folder = path.join(scratch, "was-a-folder");
    const elsewhere = path.join(scratch, "elsewhere");
    fs.mkdirSync(folder);
    fs.mkdirSync(elsewhere);
    const view = await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: folder, source: "ui" });
    fs.rmSync(folder, { recursive: true });
    fs.symlinkSync(elsewhere, folder, "dir");
    await syncSkillInstalls("test");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect((await listSkillInstalls()).find((v) => v.id === view.id)).toMatchObject({
      status: "error",
      error: "libi won't write or remove skills through a linked skills folder.",
    });
  });

  it("never rewrites an install that was removed while the run was loading skills", async () => {
    const view = await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: project, source: "ui" });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    loadEnabledSkills.mockImplementationOnce(async () => { await gate; return enabled; });
    const run = syncSkillInstalls("a");
    expect(await removeSkillInstall(view.id)).toEqual({ removed: 2 });
    release();
    await run;
    expect(fs.existsSync(path.join(project, ".agents", "skills"))).toBe(false);
    expect(await listSkillInstalls()).toEqual([]);
  });
});

describe("syncSkillInstalls reconciles one level per agent", () => {
  const REMOVE_UNREADABLE =
    "libi's skills manifest (.libi-managed.json) is unreadable — delete it and libi's skill folders to remove them.";

  /** Both levels recorded for Claude Code — as a crash after a user-level add's write but before its folder removal leaves them — plus a Codex folder install. */
  function seedBothLevels(): void {
    getDb().insert(skillInstalls).values([
      { agentId: "claude-code", scope: "user", folderPath: "", source: "ui", lastSyncedAt: new Date() },
      { agentId: "claude-code", scope: "folder", folderPath: project, source: "cli" },
      { agentId: "codex", scope: "folder", folderPath: project, source: "ui" },
    ]).run();
    writeSkillsToRoot(path.join(home, ".claude", "skills"), enabled, { external: true });
    writeSkillsToRoot(path.join(project, ".claude", "skills"), enabled, { external: true });
    writeSkillsToRoot(path.join(project, ".agents", "skills"), enabled, { external: true });
  }

  const reconciledLogs = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c) => (c[0] as { op?: string } | undefined)?.op === "folder_installs_reconciled").map((c) => c[0]);

  it("removes the folder installs of an agent that also has a user-level row — libi's files and rows — and leaves the other agent alone", async () => {
    seedBothLevels();
    fs.mkdirSync(path.join(project, ".claude", "skills", "theirs"));
    const info = vi.spyOn(serverLogger, "info");
    await syncSkillInstalls("test");
    expect(levels()).toEqual([["claude-code", "user", ""], ["codex", "folder", project]]);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "alpha"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "beta"))).toBe(false);
    expect(managedSkillNames(path.join(project, ".claude", "skills"))).toEqual([]);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "theirs"))).toBe(true);
    expect(managedSkillNames(path.join(home, ".claude", "skills"))).toEqual(["alpha", "beta"]);
    expect(managedSkillNames(path.join(project, ".agents", "skills"))).toEqual(["alpha", "beta"]);
    expect(reconciledLogs(info)).toEqual([{ tag: "skills", op: "folder_installs_reconciled", agents: 1, removed: 1, failed: 0 }]);
    // Nothing left to reconcile on the next run.
    info.mockClear();
    await syncSkillInstalls("test");
    expect(reconciledLogs(info)).toEqual([]);
  });

  it("after a crash before a user-level row's first write, one sync writes the user level and removes the folder installs — never both levels", async () => {
    getDb().insert(skillInstalls).values([
      { agentId: "claude-code", scope: "user", folderPath: "", source: "ui" },
      { agentId: "claude-code", scope: "folder", folderPath: project, source: "cli" },
    ]).run();
    writeSkillsToRoot(path.join(project, ".claude", "skills"), enabled, { external: true });
    const info = vi.spyOn(serverLogger, "info");
    await syncSkillInstalls("test");
    expect(levels()).toEqual([["claude-code", "user", ""]]);
    expect(fs.existsSync(path.join(project, ".claude", "skills"))).toBe(false);
    expect(managedSkillNames(path.join(home, ".claude", "skills"))).toEqual(["alpha", "beta"]);
    expect(reconciledLogs(info)).toEqual([{ tag: "skills", op: "folder_installs_reconciled", agents: 1, removed: 1, failed: 0 }]);
  });

  it("a user-level write that fails keeps the agent's folder installs and writes them, and leaves the user level's error", async () => {
    getDb().insert(skillInstalls).values([
      { agentId: "claude-code", scope: "user", folderPath: "", source: "ui", lastSyncedAt: new Date() },
      { agentId: "claude-code", scope: "folder", folderPath: project, source: "cli" },
    ]).run();
    writeSkillsToRoot(path.join(project, ".claude", "skills"), enabled, { external: true });
    // A file where the user-level root's parent belongs: the write fails for any user, root included.
    fs.writeFileSync(path.join(home, ".claude"), "not a folder");
    enabled.splice(0, enabled.length, skill("gamma"));
    const info = vi.spyOn(serverLogger, "info");
    await syncSkillInstalls("test");
    expect(levels()).toEqual([["claude-code", "folder", project], ["claude-code", "user", ""]]);
    expect(managedSkillNames(path.join(project, ".claude", "skills"))).toEqual(["gamma"]);
    const user = (await listSkillInstalls()).find((v) => v.scope === "user");
    expect(user?.status).toBe("error");
    expect(reconciledLogs(info)).toEqual([]);
    const sync = info.mock.calls.map((c) => c[0] as { op?: string }).filter((o) => o?.op === "installs_sync");
    expect(sync).toEqual([
      { tag: "skills", op: "installs_sync", reason: "test", rows: 2, written: 1, failed: 1, missingFolders: 0, missingRoots: 0, levelConflicts: 0 },
    ]);
  });

  it("a folder install whose skills dir became a link is not removed through it: libi's skills at the target stay, the row keeps why", async () => {
    getDb().insert(skillInstalls).values([
      { agentId: "claude-code", scope: "user", folderPath: "", source: "ui", lastSyncedAt: new Date() },
      { agentId: "claude-code", scope: "folder", folderPath: project, source: "cli" },
    ]).run();
    const shared = path.join(scratch, "shared", ".claude", "skills");
    writeSkillsToRoot(shared, enabled, { external: true });
    fs.mkdirSync(path.join(project, ".claude"));
    fs.symlinkSync(shared, path.join(project, ".claude", "skills"), "dir");
    const info = vi.spyOn(serverLogger, "info");
    await syncSkillInstalls("test");
    expect(managedSkillNames(shared)).toEqual(["alpha", "beta"]);
    expect(fs.existsSync(path.join(shared, "alpha", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(shared, ".libi-managed.json"))).toBe(true);
    expect(levels()).toEqual([["claude-code", "folder", project], ["claude-code", "user", ""]]);
    const folder = (await listSkillInstalls()).find((v) => v.scope === "folder");
    expect(folder).toMatchObject({ status: "error", error: "libi won't write or remove skills through a linked skills folder." });
    expect(reconciledLogs(info)).toEqual([{ tag: "skills", op: "folder_installs_reconciled", agents: 1, removed: 0, failed: 1 }]);
    const sync = info.mock.calls.map((c) => c[0] as { op?: string }).filter((o) => o?.op === "installs_sync");
    expect(sync).toMatchObject([{ written: 1, failed: 0, levelConflicts: 1 }]);
  });

  it("a folder install stuck behind a linked skills dir warns once, not on every later sync", async () => {
    getDb().insert(skillInstalls).values([
      { agentId: "claude-code", scope: "user", folderPath: "", source: "ui", lastSyncedAt: new Date() },
      { agentId: "claude-code", scope: "folder", folderPath: project, source: "cli" },
    ]).run();
    const shared = path.join(scratch, "shared", ".claude", "skills");
    writeSkillsToRoot(shared, enabled, { external: true });
    fs.mkdirSync(path.join(project, ".claude"));
    fs.symlinkSync(shared, path.join(project, ".claude", "skills"), "dir");
    const warn = vi.spyOn(serverLogger, "warn");
    // The reconcile exists for exactly this state, and reruns it every boot and every skill
    // toggle until the user removes the link — the row's error never changes meanwhile.
    await syncSkillInstalls("test");
    await syncSkillInstalls("test");
    await syncSkillInstalls("test");
    const refused = warn.mock.calls.map((c) => c[0] as { op?: string }).filter((o) => o?.op === "install_remove_refused");
    expect(refused).toHaveLength(1);
  });

  it("a folder install whose manifest is unreadable keeps its row and files, is not rewritten beside the user level, and goes on a later run", async () => {
    seedBothLevels();
    const folderRoot = path.join(project, ".claude", "skills");
    fs.writeFileSync(path.join(folderRoot, ".libi-managed.json"), "not json");
    const info = vi.spyOn(serverLogger, "info");
    await syncSkillInstalls("test");
    expect(levels()).toEqual([["claude-code", "folder", project], ["claude-code", "user", ""], ["codex", "folder", project]]);
    expect(fs.existsSync(path.join(folderRoot, "alpha", "SKILL.md"))).toBe(true);
    // The removal's own message, not a write's: the sync did not write this root.
    const stuck = (await listSkillInstalls()).find((v) => v.agentId === "claude-code" && v.scope === "folder");
    expect(stuck).toMatchObject({ status: "error", error: REMOVE_UNREADABLE });
    expect(reconciledLogs(info)).toEqual([{ tag: "skills", op: "folder_installs_reconciled", agents: 1, removed: 0, failed: 1 }]);

    fs.writeFileSync(path.join(folderRoot, ".libi-managed.json"), JSON.stringify({ managed: ["alpha", "beta"] }));
    await syncSkillInstalls("test");
    expect(levels()).toEqual([["claude-code", "user", ""], ["codex", "folder", project]]);
    expect(fs.existsSync(folderRoot)).toBe(false);
  });
});

describe("the root libi last wrote is recorded, so a moved user-level root is cleaned up", () => {
  const REMOVE_UNREADABLE =
    "libi's skills manifest (.libi-managed.json) is unreadable — delete it and libi's skill folders to remove them.";
  const storedRoot = (id: string): string | null | undefined =>
    getDb().select().from(skillInstalls).where(eq(skillInstalls.id, id)).get()?.lastRoot;
  const movedLogs = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c) => (c[0] as { op?: string } | undefined)?.op === "user_root_moved").map((c) => c[0]);

  let rootA: string;
  let rootB: string;
  beforeEach(() => {
    rootA = path.join(scratch, "cfg-a", "skills");
    rootB = path.join(scratch, "cfg-b", "skills");
  });

  it("a folder install records its root on write", async () => {
    const view = await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: project, source: "ui" });
    expect(storedRoot(view.id)).toBe(path.join(project, ".agents", "skills"));
  });

  it("a folder install's root never moves: a different recorded root is neither cleaned up nor logged as a move", async () => {
    const view = await addSkillInstall({ agentId: "codex", scope: "folder", folderPath: project, source: "ui" });
    const stale = path.join(scratch, "stale", ".agents", "skills");
    writeSkillsToRoot(stale, enabled, { external: true });
    getDb().update(skillInstalls).set({ lastRoot: stale }).where(eq(skillInstalls.id, view.id)).run();
    const info = vi.spyOn(serverLogger, "info");
    await syncSkillInstalls("test");
    expect(managedSkillNames(stale)).toEqual(["alpha", "beta"]);
    expect(movedLogs(info)).toEqual([]);
    expect(storedRoot(view.id)).toBe(path.join(project, ".agents", "skills"));
    getDb().update(skillInstalls).set({ lastRoot: stale }).where(eq(skillInstalls.id, view.id)).run();
    expect(await removeSkillInstall(view.id)).toEqual({ removed: 2 });
    expect(managedSkillNames(stale)).toEqual(["alpha", "beta"]);
  });

  it("a CLAUDE_CONFIG_DIR change between two syncs removes libi's copy at the old root, writes the new one, and records it", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-a"));
    const view = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
    expect(storedRoot(view.id)).toBe(rootA);
    fs.mkdirSync(path.join(rootA, "theirs"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-b"));
    const info = vi.spyOn(serverLogger, "info");
    await syncSkillInstalls("test");
    expect(fs.existsSync(path.join(rootA, "alpha"))).toBe(false);
    expect(fs.existsSync(path.join(rootA, "beta"))).toBe(false);
    expect(managedSkillNames(rootA)).toEqual([]);
    expect(fs.existsSync(path.join(rootA, "theirs"))).toBe(true);
    expect(managedSkillNames(rootB)).toEqual(["alpha", "beta"]);
    expect(storedRoot(view.id)).toBe(rootB);
    expect(movedLogs(info)).toEqual([{ tag: "skills", op: "user_root_moved", agentId: "claude-code", scope: "user", removed: 2 }]);
    expect((await listSkillInstalls())[0]).toMatchObject({ id: view.id, path: rootB, status: "up-to-date", installedCount: 2 });
    // Settled: the next run moves nothing.
    info.mockClear();
    await syncSkillInstalls("test");
    expect(movedLogs(info)).toEqual([]);
  });

  it("a failed removal at the old root keeps the old root recorded with an error naming it, writes nothing at the new one, and the next sync retries", async () => {
    // Under home, so the error names the root in ~ form; the view's path already shows the new one.
    const oldRoot = path.join(home, "old", ".claude", "skills");
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, "old", ".claude"));
    const view = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-b"));
    fs.writeFileSync(path.join(oldRoot, ".libi-managed.json"), "not json");
    await syncSkillInstalls("test");
    expect(storedRoot(view.id)).toBe(oldRoot);
    expect((await listSkillInstalls())[0]).toMatchObject({
      id: view.id,
      path: rootB,
      status: "error",
      error: `Couldn't clean up libi's skills in ~/old/.claude/skills: ${REMOVE_UNREADABLE}`,
    });
    expect(fs.existsSync(path.join(oldRoot, "alpha", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(rootB)).toBe(false);

    fs.writeFileSync(path.join(oldRoot, ".libi-managed.json"), JSON.stringify({ managed: ["alpha", "beta"] }));
    await syncSkillInstalls("test");
    expect(storedRoot(view.id)).toBe(rootB);
    expect(fs.existsSync(oldRoot)).toBe(false);
    expect(managedSkillNames(rootB)).toEqual(["alpha", "beta"]);
    expect((await listSkillInstalls())[0]).toMatchObject({ id: view.id, status: "up-to-date", error: null });
  });

  it("removing a user-level install whose old root can't be cleaned up still removes the current root and the row, and logs no path", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-a"));
    const view = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-b"));
    writeSkillsToRoot(rootB, enabled, { external: true });
    fs.writeFileSync(path.join(rootA, ".libi-managed.json"), "not json");
    const warn = vi.spyOn(serverLogger, "warn");
    expect(await removeSkillInstall(view.id)).toEqual({ removed: 2 });
    expect(levels()).toEqual([]);
    expect(fs.existsSync(rootB)).toBe(false);
    // Unreadable, so libi can't tell its folders from the user's: they stay.
    expect(fs.existsSync(path.join(rootA, "alpha", "SKILL.md"))).toBe(true);
    const cleanup = warn.mock.calls.map((c) => c[0] as { op?: string }).filter((o) => o?.op === "user_root_cleanup_failed");
    expect(cleanup).toEqual([
      { tag: "skills", op: "user_root_cleanup_failed", agentId: "claude-code", scope: "user", err: { code: null, name: "Error" } },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(scratch);
  });

  it("a user-level skills dir the user linked (a dotfiles setup) is written, moved away from, and removed through its link", async () => {
    const dotfiles = path.join(scratch, "dotfiles", "skills");
    fs.mkdirSync(dotfiles, { recursive: true });
    fs.mkdirSync(path.join(scratch, "cfg-a"));
    fs.symlinkSync(dotfiles, rootA, "dir");
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-a"));
    const view = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
    expect(managedSkillNames(dotfiles)).toEqual(["alpha", "beta"]);
    // Moved away from: libi's copy leaves the linked root.
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-b"));
    await syncSkillInstalls("test");
    expect(fs.existsSync(path.join(dotfiles, "alpha"))).toBe(false);
    expect(managedSkillNames(rootB)).toEqual(["alpha", "beta"]);
    // Back to it, then removed.
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-a"));
    await syncSkillInstalls("test");
    expect(managedSkillNames(dotfiles)).toEqual(["alpha", "beta"]);
    expect(await removeSkillInstall(view.id)).toEqual({ removed: 2 });
    expect(fs.existsSync(path.join(dotfiles, "alpha"))).toBe(false);
    expect(fs.existsSync(path.join(dotfiles, ".libi-managed.json"))).toBe(false);
    expect(fs.lstatSync(rootA).isSymbolicLink()).toBe(true);
    expect(levels()).toEqual([]);
  });

  it("removing a user-level install whose root moved since its last write removes libi's copy at the recorded root too", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-a"));
    const view = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-b"));
    expect(await removeSkillInstall(view.id)).toEqual({ removed: 2 });
    expect(fs.existsSync(rootA)).toBe(false);
    expect(levels()).toEqual([]);
  });
  describe("only a process whose environment can be trusted moves a user-level root", () => {
    const TOKEN = "LIBI_MCP_HEALTH_TOKEN";
    const SUPERVISED = "LIBI_MCP_SUPERVISED";
    const addAtRootA = async () => {
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-a"));
      const view = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
      expect(storedRoot(view.id)).toBe(rootA);
      return view;
    };

    it("the MCP child and the server syncing one row under different environments delete at neither root, and the recorded copy keeps updating", async () => {
      const view = await addAtRootA();
      const homeRoot = path.join(home, ".claude", "skills");
      const info = vi.spyOn(serverLogger, "info");
      for (const round of [1, 2]) {
        // The MCP child: marked by its supervisor, holding an env snapshot without CLAUDE_CONFIG_DIR.
        vi.stubEnv(SUPERVISED, "1");
        vi.stubEnv("CLAUDE_CONFIG_DIR", "");
        enabled.splice(0, enabled.length, skill(`child-${round}`));
        await syncSkillInstalls("test");
        expect(managedSkillNames(rootA)).toEqual([`child-${round}`]);
        expect(fs.existsSync(homeRoot)).toBe(false);
        expect(storedRoot(view.id)).toBe(rootA);
        // The server, whose environment has it.
        vi.stubEnv(SUPERVISED, undefined);
        vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-a"));
        enabled.splice(0, enabled.length, skill(`server-${round}`));
        await syncSkillInstalls("test");
        expect(managedSkillNames(rootA)).toEqual([`server-${round}`]);
        expect(fs.existsSync(homeRoot)).toBe(false);
        expect(storedRoot(view.id)).toBe(rootA);
      }
      expect(movedLogs(info)).toEqual([]);
      expect((await listSkillInstalls())[0]).toMatchObject({ id: view.id, status: "up-to-date", error: null });
    });

    it("while the desktop app's login-shell environment is pending or failed, the recorded root is written and nothing moves; once loaded, it moves", async () => {
      const view = await addAtRootA();
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-b"));
      const info = vi.spyOn(serverLogger, "info");
      for (const state of ["pending", "failed", "unrecognised"]) {
        vi.stubEnv("LIBI_SHELL_ENV", state);
        enabled.splice(0, enabled.length, skill(`s-${state}`));
        await syncSkillInstalls("test");
        expect(managedSkillNames(rootA)).toEqual([`s-${state}`]);
        expect(fs.existsSync(rootB)).toBe(false);
        expect(storedRoot(view.id)).toBe(rootA);
      }
      expect(movedLogs(info)).toEqual([]);
      vi.stubEnv("LIBI_SHELL_ENV", "loaded");
      await syncSkillInstalls("test");
      expect(fs.existsSync(rootA)).toBe(false);
      expect(managedSkillNames(rootB)).toEqual(["s-unrecognised"]);
      expect(storedRoot(view.id)).toBe(rootB);
      expect(movedLogs(info)).toEqual([{ tag: "skills", op: "user_root_moved", agentId: "claude-code", scope: "user", removed: 1 }]);
    });

    it("while untrusted, the view shows the recorded root libi's copy lives at, with its count, not the root resolved now", async () => {
      const view = await addAtRootA();
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-b"));
      vi.stubEnv("LIBI_SHELL_ENV", "failed");
      await syncSkillInstalls("test");
      expect(managedSkillNames(rootA)).toEqual(["alpha", "beta"]);
      expect((await listSkillInstalls())[0]).toMatchObject({ id: view.id, path: rootA, installedCount: 2, status: "up-to-date" });
    });

    it("an untrusted process with no recorded root yet writes the root it resolves, and records it", async () => {
      getDb().insert(skillInstalls).values({ agentId: "codex", scope: "user", folderPath: "", source: "cli" }).run();
      vi.stubEnv(SUPERVISED, "1");
      await syncSkillInstalls("test");
      const codexRoot = path.join(home, ".agents", "skills");
      expect(getDb().select().from(skillInstalls).get()?.lastRoot).toBe(codexRoot);
      expect(managedSkillNames(codexRoot)).toEqual(["alpha", "beta"]);
    });

    it("a process launched as the MCP child stays untrusted after its entry deletes the launch token, because the supervisor's marker stays", async () => {
      const view = await addAtRootA();
      vi.stubEnv(TOKEN, "launch-token");
      vi.stubEnv(SUPERVISED, "1");
      // mcp/http/index.ts deletes the token before it serves anything; nothing deletes the marker.
      vi.stubEnv(TOKEN, undefined);
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-b"));
      enabled.splice(0, enabled.length, skill("gamma"));
      await syncSkillInstalls("test");
      expect(managedSkillNames(rootA)).toEqual(["gamma"]);
      expect(fs.existsSync(rootB)).toBe(false);
      expect(storedRoot(view.id)).toBe(rootA);
    });

    it("the supervisor only ever sets its marker to \"1\" — any other value, including \"0\", is not it, and the write moves the root", async () => {
      const view = await addAtRootA();
      vi.stubEnv(SUPERVISED, "0");
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-b"));
      enabled.splice(0, enabled.length, skill("gamma"));
      await syncSkillInstalls("test");
      expect(managedSkillNames(rootB)).toEqual(["gamma"]);
      expect(fs.existsSync(rootA)).toBe(false);
      expect(storedRoot(view.id)).toBe(rootB);
    });

    it("an MCP server started by its entry file or its CLI command is untrusted; `libi connect` in the user's shell is not", async () => {
      const view = await addAtRootA();
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-b"));
      const argv = process.argv;
      const node = argv[0];
      const pkg = path.join(scratch, "pkg");
      try {
        for (const launch of [
          [node, path.join(pkg, "mcp", "http", "index.ts")],
          [node, path.join(pkg, "dist-cli", "mcp", "http", "index.js")],
          [node, path.join(pkg, "mcp", "index.ts")],
          [node, path.join(pkg, "lib", "cli", "index.ts"), "serve-mcp-http", "--port", "3457"],
          [node, path.join(pkg, "dist-cli", "lib", "cli", "index.js"), "serve-mcp"],
        ]) {
          process.argv = launch;
          await syncSkillInstalls("test");
          expect(storedRoot(view.id)).toBe(rootA);
          expect(fs.existsSync(rootB)).toBe(false);
        }
        process.argv = [node, path.join(pkg, "lib", "cli", "index.ts"), "connect"];
        await syncSkillInstalls("test");
        expect(storedRoot(view.id)).toBe(rootB);
        expect(fs.existsSync(rootA)).toBe(false);
      } finally {
        process.argv = argv;
      }
    });

    it("an untrusted process never recreates a recorded root whose folder is gone", async () => {
      const view = await addAtRootA();
      fs.rmSync(path.join(scratch, "cfg-a"), { recursive: true });
      vi.stubEnv("LIBI_SHELL_ENV", "pending");
      await syncSkillInstalls("test");
      expect(fs.existsSync(path.join(scratch, "cfg-a"))).toBe(false);
      expect(storedRoot(view.id)).toBe(rootA);
    });

    it("an untrusted process that finds its recorded root gone says so in ~ form and counts it as a missing root, not a missing folder", async () => {
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, "cfg-gone"));
      const view = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" });
      fs.rmSync(path.join(home, "cfg-gone"), { recursive: true });
      vi.stubEnv("LIBI_SHELL_ENV", "pending");
      const info = vi.spyOn(serverLogger, "info");
      await syncSkillInstalls("test");
      expect(fs.existsSync(path.join(home, "cfg-gone"))).toBe(false);
      expect((await listSkillInstalls())[0]).toMatchObject({
        id: view.id,
        status: "error",
        error: "libi's skills folder ~/cfg-gone/skills is gone.",
        installedCount: 0,
      });
      const sync = info.mock.calls.map((c) => c[0] as { op?: string }).filter((o) => o?.op === "installs_sync");
      expect(sync).toEqual([
        { tag: "skills", op: "installs_sync", reason: "test", rows: 1, written: 0, failed: 0, missingFolders: 0, missingRoots: 1, levelConflicts: 0 },
      ]);
      expect(JSON.stringify(info.mock.calls)).not.toContain(scratch);
    });

    it("a user-level add backed out in an untrusted process removes libi's copy at the recorded root it wrote to", async () => {
      // Both levels recorded (a crash state), the user level last written at cfg-a; the folder's manifest is unreadable.
      getDb().insert(skillInstalls).values([
        { agentId: "claude-code", scope: "user", folderPath: "", source: "ui", lastSyncedAt: new Date(), lastRoot: rootA },
        { agentId: "claude-code", scope: "folder", folderPath: project, source: "cli" },
      ]).run();
      writeSkillsToRoot(rootA, enabled, { external: true });
      writeSkillsToRoot(path.join(project, ".claude", "skills"), enabled, { external: true });
      fs.writeFileSync(path.join(project, ".claude", "skills", ".libi-managed.json"), "not json");
      vi.stubEnv("LIBI_SHELL_ENV", "pending");
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(scratch, "cfg-b"));
      await expect(addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" })).rejects.toBeInstanceOf(SkillInstallError);
      expect(levels()).toEqual([["claude-code", "folder", project]]);
      expect(fs.existsSync(path.join(rootA, "alpha"))).toBe(false);
      expect(fs.existsSync(rootB)).toBe(false);
    });
  });
});

describe("shortInstallError", () => {
  it("maps common codes and otherwise keeps the first line, capped", () => {
    expect(shortInstallError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe("permission denied");
    expect(shortInstallError(Object.assign(new Error("x"), { code: "EPERM" }))).toBe("permission denied");
    expect(shortInstallError(Object.assign(new Error("x"), { code: "ENOSPC" }))).toBe("disk full");
    expect(shortInstallError(Object.assign(new Error("x"), { code: "EROFS" }))).toBe("read-only file system");
    expect(shortInstallError(new Error("first line\nsecond"))).toBe("first line");
    expect(shortInstallError(new Error("y".repeat(200)))).toHaveLength(120);
    expect(shortInstallError("plain")).toBe("plain");
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

  it("a failed write to libi's own agent dir logs no path", async () => {
    const warn = vi.spyOn(serverLogger, "warn");
    const agentDir = path.join(libiHome, "agent");
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.writeFileSync(agentDir, "not a folder");
    await addSkillInstall({ agentId: "codex", scope: "user", source: "ui" });
    assertNoPathLogged(warn, scratch);
  });

  it("a failed removal during a backed-out user-level add logs no path", async () => {
    const warn = vi.spyOn(serverLogger, "warn");
    const userRoot = path.join(home, ".claude", "skills");
    fs.mkdirSync(userRoot, { recursive: true });
    fs.writeFileSync(path.join(userRoot, ".libi-managed.json"), "not json");
    const err = await addSkillInstall({ agentId: "claude-code", scope: "user", source: "ui" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillInstallError);
    assertNoPathLogged(warn, scratch);
  });

  it("a failed sync logs no path", async () => {
    await addSkillInstall({ agentId: "claude-code", scope: "folder", folderPath: project, source: "ui" });
    const error = vi.spyOn(serverLogger, "error");
    loadEnabledSkills.mockRejectedValueOnce(new Error(`boom while reading ${project}`));
    await syncSkillInstalls("test");
    assertNoPathLogged(error, scratch);
  });
});
