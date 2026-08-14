import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import {
  getConnectedAgentDir,
  getAgentDirWriteTargets,
  getLibiAgentDir,
} from "@/lib/libi-home";

describe("libi-home", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.LIBI_HOME;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns LIBI_HOME env var when set", async () => {
    process.env.LIBI_HOME = "/custom/path";
    const { getLibiHome } = await import("@/lib/libi-home");
    expect(getLibiHome()).toBe("/custom/path");
  });

  it("defaults to ~/.libi when LIBI_HOME is not set", async () => {
    const { getLibiHome } = await import("@/lib/libi-home");
    expect(getLibiHome()).toBe(path.join(os.homedir(), ".libi"));
  });

  it("ensureLibiDirs creates storage, agent, and bin subdirectories", async () => {
    const tempDir = path.join(os.tmpdir(), `libi-test-${Date.now()}`);
    process.env.LIBI_HOME = tempDir;
    try {
      const { ensureLibiDirs } = await import("@/lib/libi-home");
      ensureLibiDirs();

      expect(fs.existsSync(path.join(tempDir, "storage"))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "agent"))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "bin"))).toBe(true);
    } finally {
      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "ensureLibiDirs creates the home dir 0700 and locks the DB file 0600",
    async () => {
      const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), "libi-perm-test-"));
      const home = path.join(tempParent, "libi-home");
      process.env.LIBI_HOME = home;
      try {
        // Pre-seed a fake DB file so the 0600 lock has something to act on.
        fs.mkdirSync(home, { recursive: true });
        const dbPath = path.join(home, "libi.sqlite");
        fs.writeFileSync(dbPath, "");
        // Loosen it first so we can prove ensureLibiDirs tightens it.
        fs.chmodSync(dbPath, 0o644);

        const { ensureLibiDirs } = await import("@/lib/libi-home");
        ensureLibiDirs();

        expect(fs.statSync(home).mode & 0o777).toBe(0o700);
        expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
      } finally {
        fs.rmSync(tempParent, { recursive: true, force: true });
      }
    },
  );

  it("returns correct subdirectory paths", async () => {
    process.env.LIBI_HOME = "/test/root";
    const {
      getLibiDbPath,
      getLibiStorageDir,
      getLibiAgentDir,
      getLibiBinDir,
      getLibiPortFile,
    } = await import("@/lib/libi-home");
    expect(getLibiDbPath()).toBe("/test/root/libi.sqlite");
    expect(getLibiStorageDir()).toBe("/test/root/storage");
    expect(getLibiAgentDir()).toBe("/test/root/agent");
    expect(getLibiBinDir()).toBe("/test/root/bin");
    expect(getLibiPortFile()).toBe("/test/root/port");
  });
});

describe("libi-home skills helpers", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-home-test-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("getLibiSkillsDir resolves under LIBI_HOME", async () => {
    const { getLibiSkillsDir } = await import("@/lib/libi-home");
    expect(getLibiSkillsDir()).toBe(path.join(tmp, "skills"));
  });

  it("getBundledSkillsDir points at the repo's mcp/skills", async () => {
    const { getBundledSkillsDir } = await import("@/lib/libi-home");
    const dir = getBundledSkillsDir();
    expect(dir.endsWith(path.join("mcp", "skills"))).toBe(true);
  });

  it("ensureLibiDirs creates the skills dir", async () => {
    const { ensureLibiDirs } = await import("@/lib/libi-home");
    ensureLibiDirs();
    expect(fs.existsSync(path.join(tmp, "skills"))).toBe(true);
  });

  it("getBundledSkillsDir prefers cwd-based path when it exists", async () => {
    const { getBundledSkillsDir } = await import("@/lib/libi-home");
    const dir = getBundledSkillsDir();
    // In the dev/test environment cwd is the repo root which does have mcp/skills
    expect(dir).toBe(path.join(process.cwd(), "mcp", "skills"));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("getBundledSkillsDir falls back to a package-relative path when cwd has no mcp/skills", async () => {
    // Move cwd to a temp dir so the cwd-based candidate doesn't match
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "libi-cwd-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(elsewhere);
      const { getBundledSkillsDir } = await import("@/lib/libi-home");
      const dir = getBundledSkillsDir();
      // Should resolve to the package root (which contains mcp/skills) — never to elsewhere/mcp/skills
      expect(dir).not.toBe(path.join(elsewhere, "mcp", "skills"));
      expect(dir.endsWith(path.join("mcp", "skills"))).toBe(true);
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("getBundledSkillsDir rejects a decoy directory that exists but has zero SKILL.md files", async () => {
    // Regression for the compiled-CLI decoy: scripts/build-cli.js emits
    // dist-cli/mcp/skills/ (loader/writer/digest/registry .js) — a directory
    // that exists, has the right name, and contains zero SKILL.md files. A
    // candidate earlier in the walk-up order must never win on existence
    // alone. Simulate that shape via the cwd-based candidate: a `mcp/skills`
    // dir that exists but is empty (no `<name>/SKILL.md` children).
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "libi-decoy-"));
    const decoyDir = path.join(elsewhere, "mcp", "skills");
    fs.mkdirSync(decoyDir, { recursive: true });
    fs.writeFileSync(path.join(decoyDir, "registry.js"), "// not a skill");
    const prevCwd = process.cwd();
    try {
      process.chdir(elsewhere);
      const { getBundledSkillsDir } = await import("@/lib/libi-home");
      const dir = getBundledSkillsDir();
      expect(dir).not.toBe(decoyDir);
      expect(dir.endsWith(path.join("mcp", "skills"))).toBe(true);
      expect(fs.existsSync(dir)).toBe(true);
      // The resolved dir must actually contain real skills, not just exist.
      const hasRealSkill = fs
        .readdirSync(dir, { withFileTypes: true })
        .some((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "SKILL.md")));
      expect(hasRealSkill).toBe(true);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("connected agent dir", () => {
  const saved = process.env.LIBI_CONNECT_AGENT_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.LIBI_CONNECT_AGENT_DIR;
    else process.env.LIBI_CONNECT_AGENT_DIR = saved;
  });

  it("getConnectedAgentDir is null when env is unset", () => {
    delete process.env.LIBI_CONNECT_AGENT_DIR;
    expect(getConnectedAgentDir()).toBeNull();
  });

  it("getConnectedAgentDir resolves the env path to absolute", () => {
    process.env.LIBI_CONNECT_AGENT_DIR = "/tmp/my-proj";
    expect(getConnectedAgentDir()).toBe("/tmp/my-proj");
  });

  it("write targets are [default] without a connected dir", () => {
    delete process.env.LIBI_CONNECT_AGENT_DIR;
    expect(getAgentDirWriteTargets()).toEqual([getLibiAgentDir()]);
  });

  it("write targets are [default, connected] in connect-agent mode", () => {
    process.env.LIBI_CONNECT_AGENT_DIR = "/tmp/my-proj";
    expect(getAgentDirWriteTargets()).toEqual([getLibiAgentDir(), "/tmp/my-proj"]);
  });

  it("write targets dedupe when connected equals the default", () => {
    process.env.LIBI_CONNECT_AGENT_DIR = getLibiAgentDir();
    expect(getAgentDirWriteTargets()).toEqual([getLibiAgentDir()]);
  });
});
