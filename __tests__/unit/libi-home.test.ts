import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import {
  getLibiAgentDir,
  resolveMcpHttpPort,
  DEFAULT_MCP_PORT,
  getCurrentMcpPort,
  getCurrentPort,
  LIBI_SERVER_PORT_ENV,
  removePortFileIfOwned,
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

describe("mcp http port", () => {
  const savedHome = process.env.LIBI_HOME;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = savedHome;
  });

  // NodeJS.ProcessEnv is augmented (by next/types/global.d.ts) to REQUIRE
  // NODE_ENV, so a fresh literal can't satisfy the type at compile time even
  // though it's a valid string map at runtime — same workaround as
  // mcp/registry/server-prober.ts and lib/runtime/runtime-install.ts.
  it("LIBI_MCP_PORT wins", () => {
    expect(resolveMcpHttpPort({ LIBI_MCP_PORT: "4000", PORT: "3456" } as unknown as NodeJS.ProcessEnv)).toBe(4000);
    expect(resolveMcpHttpPort({ LIBI_MCP_PORT: "4100" } as unknown as NodeJS.ProcessEnv)).toBe(4100);
  });
  it("defaults to DEFAULT_MCP_PORT, never a port derived from the studio's", () => {
    // Deriving from the studio port is exactly what broke `libi connect` on
    // the desktop build: the packaged studio binds `listen(0)`, so a derived
    // aggregator port moved on every launch and the saved URL went stale.
    expect(DEFAULT_MCP_PORT).toBe(3457);
    expect(resolveMcpHttpPort({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MCP_PORT);
    expect(resolveMcpHttpPort({ PORT: "3500" } as unknown as NodeJS.ProcessEnv)).toBe(DEFAULT_MCP_PORT);
    expect(resolveMcpHttpPort({ LIBI_PORT: "3600" } as unknown as NodeJS.ProcessEnv)).toBe(DEFAULT_MCP_PORT);
  });
  it("falls back to the default when LIBI_MCP_PORT is not a port number", () => {
    // `Number.parseInt("abc")` is NaN, which used to reach `listen(NaN)` — an
    // OS-assigned port that every other consumer of this function disagreed
    // with, with no error anywhere.
    for (const bad of ["abc", "70000", "0", "-1", " ", "99999999"]) {
      expect(resolveMcpHttpPort({ LIBI_MCP_PORT: bad } as unknown as NodeJS.ProcessEnv)).toBe(
        DEFAULT_MCP_PORT,
      );
    }
  });
  it("getCurrentMcpPort reads the mcp-port file, falling back to the resolver", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-home-"));
    process.env.LIBI_HOME = home;
    expect(getCurrentMcpPort()).toBe(resolveMcpHttpPort(process.env));
    fs.writeFileSync(path.join(home, "mcp-port"), "3999");
    expect(getCurrentMcpPort()).toBe(3999);
  });
});

/**
 * `<LIBI_HOME>/port` is shared by every libi running against that home, and the
 * last one to boot wins it. A second desktop launch on a fresh Windows install
 * rewrote it to its own port and then died, so the FIRST window's MCP child read
 * the dead port and every libi tool failed with "failed to reach libi server"
 * while its own server was fine. A supervised child is handed its parent's port
 * and must prefer it; everything with no parent server keeps reading the file.
 */
describe("getCurrentPort", () => {
  const saved = {
    LIBI_HOME: process.env.LIBI_HOME,
    LIBI_PORT: process.env.LIBI_PORT,
    LIBI_SERVER_PORT: process.env.LIBI_SERVER_PORT,
  };
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-current-port-"));
    process.env.LIBI_HOME = home;
    delete process.env.LIBI_PORT;
    delete process.env.LIBI_SERVER_PORT;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("names the child's variable LIBI_SERVER_PORT", () => {
    expect(LIBI_SERVER_PORT_ENV).toBe("LIBI_SERVER_PORT");
  });

  it("prefers LIBI_SERVER_PORT over a port file another instance has rewritten", () => {
    fs.writeFileSync(path.join(home, "port"), "55303");
    process.env.LIBI_PORT = "3499";
    process.env.LIBI_SERVER_PORT = "55268";
    expect(getCurrentPort()).toBe(55268);
  });

  it("without LIBI_SERVER_PORT reads the port file, then LIBI_PORT, then 3456", () => {
    expect(getCurrentPort()).toBe(3456);
    process.env.LIBI_PORT = "3499";
    expect(getCurrentPort()).toBe(3499);
    fs.writeFileSync(path.join(home, "port"), "55303\n");
    expect(getCurrentPort()).toBe(55303);
  });

  it("an empty LIBI_SERVER_PORT is treated as unset", () => {
    fs.writeFileSync(path.join(home, "port"), "55303");
    process.env.LIBI_SERVER_PORT = "";
    expect(getCurrentPort()).toBe(55303);
  });

  it("still throws on an unparseable value from any source", () => {
    process.env.LIBI_SERVER_PORT = "not-a-port";
    expect(() => getCurrentPort()).toThrow(/could not parse port value "not-a-port"/);
    delete process.env.LIBI_SERVER_PORT;
    fs.writeFileSync(path.join(home, "port"), "garbage");
    expect(() => getCurrentPort()).toThrow(/could not parse port value "garbage"/);
    fs.rmSync(path.join(home, "port"));
    process.env.LIBI_PORT = "nope";
    expect(() => getCurrentPort()).toThrow(/could not parse port value "nope"/);
  });
});

describe("removePortFileIfOwned", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-owned-port-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes a port file that still names the given port", () => {
    const file = path.join(dir, "port");
    fs.writeFileSync(file, "55268\n");
    expect(removePortFileIfOwned(file, 55268)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves a port file another instance has rewritten", () => {
    const file = path.join(dir, "port");
    fs.writeFileSync(file, "55303");
    expect(removePortFileIfOwned(file, "55268")).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("55303");
  });

  it("is a no-op for a missing file or a null port", () => {
    const file = path.join(dir, "port");
    expect(removePortFileIfOwned(file, 55268)).toBe(false);
    fs.writeFileSync(file, "55268");
    expect(removePortFileIfOwned(file, null)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });
});
