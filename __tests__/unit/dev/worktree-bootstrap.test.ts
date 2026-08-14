import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import net from "net";

import {
  inDevCheckout,
  isLinkedWorktree,
  resolveKey,
  setupWorktreeHome,
  META_FILENAME,
  SHARED_LINKS,
  hashPort,
  pickPort,
  PORT_RANGE_START,
  PORT_RANGE_SIZE,
  updateLaunchJson,
  updateMcpJson,
  registerCanonicalLaunchConfigs,
  cdpPortForNextPort,
  CDP_PORT_BASE,
  pruneOrphans,
  resolveWorktreeEnv,
  WORKTREE_HOMES_ROOT,
  parseDotenv,
  loadCanonicalDotenv,
  resolveCanonicalRoot,
} from "@/lib/dev/worktree-bootstrap";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-wb-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Initialize a bare-minimum git repo with one commit so worktrees can be added. */
function initRepo(dir: string): void {
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t && git config user.name t", { cwd: dir });
  fs.writeFileSync(path.join(dir, "README"), "x");
  execSync("git add . && git commit -qm init", { cwd: dir });
}

describe("inDevCheckout", () => {
  it("true when a .git/ dir exists above the start path", () => {
    initRepo(tmp);
    const sub = path.join(tmp, "deep", "nested", "dir");
    fs.mkdirSync(sub, { recursive: true });
    expect(inDevCheckout(sub)).toBe(true);
  });
  it("false when no .git/ is found walking up", () => {
    expect(inDevCheckout("/tmp")).toBe(false);
  });
  it("false for a package installed under the consumer's node_modules, even though the consumer's repo has .git", () => {
    // The real bug: `libi` at <userproject>/node_modules/libi with a
    // <userproject>/.git reported `true`, and lib/cli/studio.ts then spawned
    // `npx next dev` INSIDE THE USER'S PROJECT.
    initRepo(tmp);
    const pkg = path.join(tmp, "node_modules", "libi");
    fs.mkdirSync(path.join(pkg, "lib", "cli"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), '{"name":"libi"}');
    expect(inDevCheckout(path.join(pkg, "lib", "cli"))).toBe(false);
  });
  it("false for an extracted runtime OUTSIDE node_modules whose ancestor happens to be a git repo (e.g. a ~/.git dotfiles repo)", () => {
    initRepo(tmp);
    const pkg = path.join(tmp, "runtime", "libi-0.1.0");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), '{"name":"libi"}');
    expect(inDevCheckout(path.join(pkg, "bin"))).toBe(false);
  });
  it("still true for a real dev checkout (package.json AND .git at the same root)", () => {
    initRepo(tmp);
    fs.writeFileSync(path.join(tmp, "package.json"), '{"name":"libi"}');
    const sub = path.join(tmp, "lib", "cli");
    fs.mkdirSync(sub, { recursive: true });
    expect(inDevCheckout(sub)).toBe(true);
  });
});

describe("isLinkedWorktree", () => {
  it("false in the primary checkout", () => {
    initRepo(tmp);
    expect(isLinkedWorktree(tmp)).toBe(false);
  });
  it("true in a `git worktree add`-created linked worktree", () => {
    initRepo(tmp);
    const wt = path.join(tmp, "..", `${path.basename(tmp)}-wt`);
    execSync(`git worktree add -q "${wt}" -b feat`, { cwd: tmp });
    try {
      expect(isLinkedWorktree(wt)).toBe(true);
    } finally {
      execSync(`git worktree remove --force "${wt}"`, { cwd: tmp });
    }
  });
});

describe("resolveKey", () => {
  it("uses path.basename of the worktree path", () => {
    expect(resolveKey("/a/b/c/zen-zhukovsky", [])).toBe("zen-zhukovsky");
  });
  it("appends a 6-char hash when a different worktree already claims that basename", () => {
    const k1 = resolveKey("/x/foo", []);
    const k2 = resolveKey("/y/foo", [
      { key: "foo", worktreePath: "/x/foo" },
    ]);
    expect(k1).toBe("foo");
    expect(k2).toMatch(/^foo-[0-9a-f]{6}$/);
  });
  it("returns the same key when the existing entry matches (idempotent)", () => {
    expect(
      resolveKey("/x/foo", [{ key: "foo", worktreePath: "/x/foo" }]),
    ).toBe("foo");
  });
});

describe("setupWorktreeHome", () => {
  function fakeLibiRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-root-"));
    for (const sub of SHARED_LINKS) {
      fs.mkdirSync(path.join(root, sub), { recursive: true });
    }
    return root;
  }

  it("creates the home dir + meta + shared symlinks", () => {
    const libiRoot = fakeLibiRoot();
    const wt = "/some/worktree/path";
    const home = path.join(libiRoot, "worktrees", "feat-x");
    setupWorktreeHome({ home, worktreePath: wt, libiRoot });
    expect(fs.existsSync(home)).toBe(true);
    const meta = JSON.parse(
      fs.readFileSync(path.join(home, META_FILENAME), "utf-8"),
    );
    expect(meta.worktreePath).toBe(wt);
    expect(typeof meta.createdAt).toBe("string");
    for (const sub of SHARED_LINKS) {
      const link = path.join(home, sub);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(path.join(libiRoot, sub));
    }
    fs.rmSync(libiRoot, { recursive: true, force: true });
  });

  it("is idempotent (no-op on second call with same args)", () => {
    const libiRoot = fakeLibiRoot();
    const home = path.join(libiRoot, "worktrees", "feat-y");
    setupWorktreeHome({ home, worktreePath: "/wt", libiRoot });
    setupWorktreeHome({ home, worktreePath: "/wt", libiRoot });
    for (const sub of SHARED_LINKS) {
      expect(fs.lstatSync(path.join(home, sub)).isSymbolicLink()).toBe(true);
    }
    fs.rmSync(libiRoot, { recursive: true, force: true });
  });

  it("replaces a wrong-target symlink", () => {
    const libiRoot = fakeLibiRoot();
    const home = path.join(libiRoot, "worktrees", "feat-z");
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync("/somewhere/else", path.join(home, "bin"));
    setupWorktreeHome({ home, worktreePath: "/wt", libiRoot });
    expect(fs.readlinkSync(path.join(home, "bin"))).toBe(
      path.join(libiRoot, "bin"),
    );
    fs.rmSync(libiRoot, { recursive: true, force: true });
  });

  it("refuses to overwrite a real file/dir already in place (throws)", () => {
    const libiRoot = fakeLibiRoot();
    const home = path.join(libiRoot, "worktrees", "feat-w");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "bin"), "real-file");
    expect(() =>
      setupWorktreeHome({ home, worktreePath: "/wt", libiRoot }),
    ).toThrow(/refusing to replace/);
    fs.rmSync(libiRoot, { recursive: true, force: true });
  });

  it("creates a fresh migrated DB on first creation (does NOT copy canonical)", () => {
    const libiRoot = fakeLibiRoot();
    // A canonical DB exists — the worktree must ignore it and migrate fresh
    // so it never inherits the canonical's (possibly broken) migration journal.
    fs.writeFileSync(path.join(libiRoot, "libi.sqlite"), "canonical-db-bytes");
    const home = path.join(libiRoot, "worktrees", "feat-seed");
    const calls: Array<[string, string]> = [];
    const migrate = (dbPath: string, folder: string) => {
      calls.push([dbPath, folder]);
      fs.writeFileSync(dbPath, "fresh-migrated-db");
    };
    setupWorktreeHome({ home, worktreePath: "/wt", libiRoot, migrate });
    const dest = path.join(home, "libi.sqlite");
    expect(fs.existsSync(dest)).toBe(true);
    // Fresh-migrated, NOT a byte-copy of the canonical DB.
    expect(fs.readFileSync(dest, "utf-8")).toBe("fresh-migrated-db");
    expect(calls).toEqual([[dest, path.join("/wt", "drizzle", "sqlite")]]);
    fs.rmSync(libiRoot, { recursive: true, force: true });
  });

  it("does not re-create the DB on subsequent runs (preserves worktree-local writes)", () => {
    const libiRoot = fakeLibiRoot();
    const home = path.join(libiRoot, "worktrees", "feat-noreseed");
    let calls = 0;
    const migrate = (dbPath: string) => {
      calls++;
      fs.writeFileSync(dbPath, "fresh-migrated-db");
    };
    setupWorktreeHome({ home, worktreePath: "/wt", libiRoot, migrate });
    // Simulate worktree-local writes mutating the DB.
    fs.writeFileSync(path.join(home, "libi.sqlite"), "worktree-mutated");
    setupWorktreeHome({ home, worktreePath: "/wt", libiRoot, migrate });
    expect(calls).toBe(1); // migrate runs only on first creation
    expect(fs.readFileSync(path.join(home, "libi.sqlite"), "utf-8")).toBe(
      "worktree-mutated",
    );
    fs.rmSync(libiRoot, { recursive: true, force: true });
  });

  it("creates a fresh DB even when the canonical libi.sqlite is missing", () => {
    const libiRoot = fakeLibiRoot();
    // No libi.sqlite at libiRoot — worktrees no longer depend on it.
    const home = path.join(libiRoot, "worktrees", "feat-nodb");
    const migrate = (dbPath: string) =>
      fs.writeFileSync(dbPath, "fresh-migrated-db");
    setupWorktreeHome({ home, worktreePath: "/wt", libiRoot, migrate });
    expect(fs.readFileSync(path.join(home, "libi.sqlite"), "utf-8")).toBe(
      "fresh-migrated-db",
    );
    fs.rmSync(libiRoot, { recursive: true, force: true });
  });
});

describe("hashPort", () => {
  it("is deterministic and within range", () => {
    const p1 = hashPort("/x/foo");
    const p2 = hashPort("/x/foo");
    const p3 = hashPort("/x/bar");
    expect(p1).toBe(p2);
    expect(p1).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(p1).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
    expect(p3).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(p3).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
  });
});

describe("pickPort", () => {
  it("returns the hashed port when it is free", async () => {
    const p = await pickPort("/test/path/picker-free");
    expect(p).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(p).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
  });

  it("scans forward past an in-use port", async () => {
    const wt = "/test/path/picker-busy";
    const desired = hashPort(wt);
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) =>
      blocker.once("error", reject).listen(desired, "127.0.0.1", resolve),
    );
    try {
      const got = await pickPort(wt);
      expect(got).not.toBe(desired);
      expect(got).toBeGreaterThanOrEqual(PORT_RANGE_START);
      expect(got).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
    } finally {
      await new Promise<void>((res) => blocker.close(() => res()));
    }
  });
});

describe("updateLaunchJson", () => {
  function seedLaunch(dir: string, port: number): string {
    const p = path.join(dir, ".claude");
    fs.mkdirSync(p, { recursive: true });
    const launch = {
      version: "0.0.1",
      configurations: [
        { name: "Libi", port, autoPort: false },
        { name: "Other", port: 9999 },
      ],
    };
    const file = path.join(p, "launch.json");
    fs.writeFileSync(file, JSON.stringify(launch, null, 2));
    return file;
  }

  it("rewrites the Libi config's port and leaves other configs alone", () => {
    const file = seedLaunch(tmp, 3456);
    updateLaunchJson({ worktreePath: tmp, port: 3461 });
    const after = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(after.configurations[0].port).toBe(3461);
    expect(after.configurations[0].autoPort).toBe(false);
    expect(after.configurations[1].port).toBe(9999);
  });

  it("is a no-op when the port already matches", () => {
    const file = seedLaunch(tmp, 3461);
    const before = fs.readFileSync(file, "utf-8");
    updateLaunchJson({ worktreePath: tmp, port: 3461 });
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });

  it("does not throw when .claude/launch.json is missing", () => {
    expect(() =>
      updateLaunchJson({ worktreePath: tmp, port: 3461 }),
    ).not.toThrow();
  });

  it("does not throw when not in a git repo (skip-worktree silently skipped)", () => {
    seedLaunch(tmp, 3456);
    expect(() =>
      updateLaunchJson({ worktreePath: tmp, port: 3461 }),
    ).not.toThrow();
  });

  it("rewrites the Libi Electron CDP port when cdpPort is given", () => {
    const p = path.join(tmp, ".claude");
    fs.mkdirSync(p, { recursive: true });
    const file = path.join(p, "launch.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: "0.0.1",
        configurations: [
          { name: "Libi", port: 3456, autoPort: false },
          { name: "Libi Electron", port: 9222, autoPort: false },
        ],
      }),
    );
    updateLaunchJson({ worktreePath: tmp, port: 3463, cdpPort: 9229 });
    const after = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(after.configurations[0].port).toBe(3463);
    expect(after.configurations[1].port).toBe(9229);
  });
});

describe("cdpPortForNextPort", () => {
  it("derives the CDP port 1:1 from the Next port offset", () => {
    expect(cdpPortForNextPort(PORT_RANGE_START)).toBe(CDP_PORT_BASE);
    expect(cdpPortForNextPort(3463)).toBe(9229);
    expect(cdpPortForNextPort(3475)).toBe(CDP_PORT_BASE + 19);
  });
});

describe("updateMcpJson", () => {
  function seedMcp(dir: string, endpointPort: number): string {
    const file = path.join(dir, ".mcp.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          "electron-playwright": {
            type: "stdio",
            command: "npx",
            args: ["-y", "@playwright/mcp@latest", `--cdp-endpoint=http://localhost:${endpointPort}`],
          },
        },
      }),
    );
    return file;
  }

  it("rewrites the playwright --cdp-endpoint to the worktree's CDP port", () => {
    const file = seedMcp(tmp, 9222);
    updateMcpJson({ worktreePath: tmp, cdpPort: 9229 });
    const after = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(after.mcpServers["electron-playwright"].args).toContain(
      "--cdp-endpoint=http://localhost:9229",
    );
  });

  it("is a no-op when the endpoint already matches", () => {
    const file = seedMcp(tmp, 9229);
    const before = fs.readFileSync(file, "utf-8");
    updateMcpJson({ worktreePath: tmp, cdpPort: 9229 });
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });

  it("does not throw when .mcp.json is missing", () => {
    expect(() => updateMcpJson({ worktreePath: tmp, cdpPort: 9229 })).not.toThrow();
  });
});

describe("registerCanonicalLaunchConfigs", () => {
  function seedCanonical(dir: string): string {
    const p = path.join(dir, ".claude");
    fs.mkdirSync(p, { recursive: true });
    const file = path.join(p, "launch.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: "0.0.1",
        configurations: [
          { name: "Libi", port: 3456, autoPort: false },
          { name: "Libi Electron", port: 9222, autoPort: false },
        ],
      }),
    );
    return file;
  }

  it("adds worktree-named configs pointing at the worktree's entry scripts + ports", () => {
    const file = seedCanonical(tmp);
    const wt = path.join(tmp, "wt-a");
    fs.mkdirSync(wt, { recursive: true });
    registerCanonicalLaunchConfigs({
      canonicalRoot: tmp,
      worktreePath: wt,
      key: "wt-a",
      port: 3463,
      cdpPort: 9229,
    });
    const after = JSON.parse(fs.readFileSync(file, "utf-8"));
    const next = after.configurations.find((c: { name: string }) => c.name === "Libi (wt-a)");
    const electron = after.configurations.find(
      (c: { name: string }) => c.name === "Libi Electron (wt-a)",
    );
    expect(next.port).toBe(3463);
    expect(next.runtimeArgs[0]).toBe(path.join(wt, "bin", "libi.js"));
    expect(electron.port).toBe(9229);
    expect(electron.runtimeArgs[0]).toBe(path.join(wt, "scripts", "dev-electron.js"));
    // canonical's own configs are preserved
    expect(after.configurations.find((c: { name: string }) => c.name === "Libi")).toBeDefined();
  });

  it("is idempotent — re-running replaces rather than duplicates our entries", () => {
    seedCanonical(tmp);
    const wt = path.join(tmp, "wt-a");
    fs.mkdirSync(wt, { recursive: true });
    const args = { canonicalRoot: tmp, worktreePath: wt, key: "wt-a", port: 3463, cdpPort: 9229 };
    registerCanonicalLaunchConfigs(args);
    registerCanonicalLaunchConfigs(args);
    const after = JSON.parse(fs.readFileSync(path.join(tmp, ".claude/launch.json"), "utf-8"));
    const ours = after.configurations.filter((c: { name: string }) => /\(wt-a\)/.test(c.name));
    expect(ours).toHaveLength(2);
  });

  it("prunes entries whose worktree directory no longer exists", () => {
    seedCanonical(tmp);
    const live = path.join(tmp, "wt-live");
    fs.mkdirSync(live, { recursive: true });
    // Register a live one, then a stale one whose dir we never create.
    registerCanonicalLaunchConfigs({ canonicalRoot: tmp, worktreePath: live, key: "wt-live", port: 3463, cdpPort: 9229 });
    const stale = path.join(tmp, "wt-stale-gone");
    fs.mkdirSync(stale, { recursive: true });
    registerCanonicalLaunchConfigs({ canonicalRoot: tmp, worktreePath: stale, key: "wt-stale", port: 3464, cdpPort: 9230 });
    fs.rmSync(stale, { recursive: true, force: true });
    // A subsequent run prunes the stale entries (dir gone).
    registerCanonicalLaunchConfigs({ canonicalRoot: tmp, worktreePath: live, key: "wt-live", port: 3463, cdpPort: 9229 });
    const after = JSON.parse(fs.readFileSync(path.join(tmp, ".claude/launch.json"), "utf-8"));
    const names = after.configurations.map((c: { name: string }) => c.name);
    expect(names).toContain("Libi (wt-live)");
    expect(names).not.toContain("Libi (wt-stale)");
    expect(names).not.toContain("Libi Electron (wt-stale)");
  });

  it("does not throw when the canonical launch.json is missing", () => {
    expect(() =>
      registerCanonicalLaunchConfigs({ canonicalRoot: tmp, worktreePath: tmp, key: "k", port: 3463, cdpPort: 9229 }),
    ).not.toThrow();
  });
});

describe("pruneOrphans", () => {
  function makeHome(rootDir: string, key: string, worktreePath: string) {
    const dir = path.join(rootDir, key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, META_FILENAME),
      JSON.stringify({ worktreePath, createdAt: new Date().toISOString() }),
    );
    return dir;
  }

  it("deletes homes whose worktreePath no longer exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-root-"));
    const alive = path.join(tmp, "alive-wt");
    fs.mkdirSync(alive);
    const aliveHome = makeHome(root, "alive", alive);
    const orphanHome = makeHome(root, "orphan", "/nonexistent/path-x");
    pruneOrphans({ root, currentKey: "alive" });
    expect(fs.existsSync(aliveHome)).toBe(true);
    expect(fs.existsSync(orphanHome)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("never deletes the currently-booting key, even if its meta is bad", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-root-"));
    const bootingHome = path.join(root, "booting");
    fs.mkdirSync(bootingHome, { recursive: true });
    fs.writeFileSync(path.join(bootingHome, META_FILENAME), "not-json");
    pruneOrphans({ root, currentKey: "booting" });
    expect(fs.existsSync(bootingHome)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("skips entries with malformed meta (logs + survives)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-root-"));
    const weird = path.join(root, "weird");
    fs.mkdirSync(weird);
    fs.writeFileSync(path.join(weird, META_FILENAME), "{not json");
    expect(() =>
      pruneOrphans({ root, currentKey: "active" }),
    ).not.toThrow();
    expect(fs.existsSync(weird)).toBe(true); // unsafe to delete → leave
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not throw when the root dir is missing", () => {
    expect(() =>
      pruneOrphans({ root: "/does/not/exist", currentKey: "x" }),
    ).not.toThrow();
  });
});

describe("resolveWorktreeEnv", () => {
  function makeLibiHome(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-libi-"));
    for (const sub of SHARED_LINKS) {
      fs.mkdirSync(path.join(root, sub), { recursive: true });
    }
    fs.mkdirSync(path.join(root, "worktrees"), { recursive: true });
    return root;
  }

  it("returns {} when start is not in a dev checkout", async () => {
    const r = await resolveWorktreeEnv({
      startPath: "/tmp",
      cwd: "/tmp",
      libiRoot: makeLibiHome(),
      now: () => "T",
    });
    expect(r).toEqual({});
  });

  it("returns {} in the primary checkout (not a linked worktree)", async () => {
    initRepo(tmp);
    const r = await resolveWorktreeEnv({
      startPath: tmp,
      cwd: tmp,
      libiRoot: makeLibiHome(),
      now: () => "T",
    });
    expect(r).toEqual({});
  });

  it("resolves home + port + log line in a real linked worktree", async () => {
    initRepo(tmp);
    const wt = path.join(tmp, "..", `${path.basename(tmp)}-wt`);
    execSync(`git worktree add -q "${wt}" -b feat`, { cwd: tmp });
    const libiRoot = makeLibiHome();
    try {
      const r = await resolveWorktreeEnv({
        startPath: wt,
        cwd: wt,
        libiRoot,
        env: {},
        now: () => "T",
      });
      expect(r.libiHome).toBe(
        path.join(libiRoot, "worktrees", path.basename(wt)),
      );
      expect(r.port).toBeGreaterThanOrEqual(PORT_RANGE_START);
      expect(r.port).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
      expect(r.logLine).toMatch(/\[libi\/dev] worktree=/);
      expect(fs.existsSync(path.join(r.libiHome!, META_FILENAME))).toBe(true);
    } finally {
      execSync(`git worktree remove --force "${wt}"`, { cwd: tmp });
      fs.rmSync(libiRoot, { recursive: true, force: true });
    }
  });

  it("honors explicit env overrides (LIBI_HOME / LIBI_PORT win individually)", async () => {
    initRepo(tmp);
    const wt = path.join(tmp, "..", `${path.basename(tmp)}-wt2`);
    execSync(`git worktree add -q "${wt}" -b feat2`, { cwd: tmp });
    const libiRoot = makeLibiHome();
    try {
      const r = await resolveWorktreeEnv({
        startPath: wt,
        cwd: wt,
        libiRoot,
        env: { LIBI_HOME: "/custom/home" },
        now: () => "T",
      });
      // LIBI_HOME omitted from result (user already set it)
      expect(r.libiHome).toBeUndefined();
      // port still auto-resolved
      expect(typeof r.port).toBe("number");
    } finally {
      execSync(`git worktree remove --force "${wt}"`, { cwd: tmp });
      fs.rmSync(libiRoot, { recursive: true, force: true });
    }
  });

  it("falls back to {} when an internal step throws (e.g. bad libiRoot)", async () => {
    initRepo(tmp);
    const wt = path.join(tmp, "..", `${path.basename(tmp)}-wt3`);
    execSync(`git worktree add -q "${wt}" -b feat3`, { cwd: tmp });
    try {
      // libiRoot points at a file (not a dir) → setupWorktreeHome will throw.
      const badRoot = path.join(tmp, "not-a-dir");
      fs.writeFileSync(badRoot, "x");
      const r = await resolveWorktreeEnv({
        startPath: wt,
        cwd: wt,
        libiRoot: badRoot,
        env: {},
        now: () => "T",
      });
      expect(r).toEqual({});
    } finally {
      execSync(`git worktree remove --force "${wt}"`, { cwd: tmp });
    }
  });

  it("populates envOverrides from canonical .env.local", async () => {
    initRepo(tmp);
    // Canonical repo gets the dotenv files
    fs.writeFileSync(
      path.join(tmp, ".env"),
      "# comment\nFOO=base\nSHARED=from-env\n",
    );
    fs.writeFileSync(
      path.join(tmp, ".env.local"),
      "ELEVENLABS_API_KEY=\"sk_test_123\"\nSHARED=from-local\n",
    );
    const wt = path.join(tmp, "..", `${path.basename(tmp)}-wt-env`);
    execSync(`git worktree add -q "${wt}" -b feat-env`, { cwd: tmp });
    const libiRoot = makeLibiHome();
    try {
      const r = await resolveWorktreeEnv({
        startPath: wt,
        cwd: wt,
        libiRoot,
        env: {},
        now: () => "T",
      });
      expect(r.envOverrides).toMatchObject({
        ELEVENLABS_API_KEY: "sk_test_123",
        FOO: "base",
        // .env.local wins over .env on collisions
        SHARED: "from-local",
      });
      expect(r.envFiles).toEqual([".env.local", ".env"]);
      expect(r.logLine).toMatch(/\+envFiles=\.env\.local,\.env/);
    } finally {
      execSync(`git worktree remove --force "${wt}"`, { cwd: tmp });
      fs.rmSync(libiRoot, { recursive: true, force: true });
    }
  });

  it("omits envOverrides / envFiles when canonical has no dotenv files", async () => {
    initRepo(tmp);
    const wt = path.join(tmp, "..", `${path.basename(tmp)}-wt-noenv`);
    execSync(`git worktree add -q "${wt}" -b feat-noenv`, { cwd: tmp });
    const libiRoot = makeLibiHome();
    try {
      const r = await resolveWorktreeEnv({
        startPath: wt,
        cwd: wt,
        libiRoot,
        env: {},
        now: () => "T",
      });
      expect(r.envOverrides).toBeUndefined();
      expect(r.envFiles).toBeUndefined();
      expect(r.logLine).not.toMatch(/\+envFiles=/);
    } finally {
      execSync(`git worktree remove --force "${wt}"`, { cwd: tmp });
      fs.rmSync(libiRoot, { recursive: true, force: true });
    }
  });
});

describe("parseDotenv", () => {
  it("parses simple KEY=value pairs", () => {
    expect(parseDotenv("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });
  it("strips matching double or single quotes", () => {
    expect(parseDotenv('K1="hello world"\nK2=\'plain\'\nK3=unquoted')).toEqual({
      K1: "hello world",
      K2: "plain",
      K3: "unquoted",
    });
  });
  it("ignores blank lines and `#` comments", () => {
    expect(parseDotenv("\n# comment\n\nK=v\n   # indented comment is also a line\nL=2")).toEqual({
      K: "v",
      L: "2",
    });
  });
  it("preserves `=` inside the value (only splits on first =)", () => {
    expect(parseDotenv("URL=postgres://u:p@h/db?x=1&y=2")).toEqual({
      URL: "postgres://u:p@h/db?x=1&y=2",
    });
  });
  it("rejects malformed keys (no leading digit, no special chars)", () => {
    expect(parseDotenv("9BAD=x\nGOOD_KEY=y\nfoo.bar=z")).toEqual({ GOOD_KEY: "y" });
  });
  it("does NOT expand shell variables", () => {
    // Literal — no interpolation
    expect(parseDotenv("K=$HOME/x")).toEqual({ K: "$HOME/x" });
  });
});

describe("loadCanonicalDotenv", () => {
  it("returns empty when no dotenv files exist", () => {
    const r = loadCanonicalDotenv(tmp);
    expect(r.envOverrides).toEqual({});
    expect(r.envFiles).toEqual([]);
  });
  it("reads .env.local alone when only it exists", () => {
    fs.writeFileSync(path.join(tmp, ".env.local"), "K=local");
    const r = loadCanonicalDotenv(tmp);
    expect(r.envOverrides).toEqual({ K: "local" });
    expect(r.envFiles).toEqual([".env.local"]);
  });
  it("merges .env + .env.local with .env.local winning", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "K=from-env\nONLY_BASE=z");
    fs.writeFileSync(path.join(tmp, ".env.local"), "K=from-local\nONLY_LOCAL=y");
    const r = loadCanonicalDotenv(tmp);
    expect(r.envOverrides).toEqual({
      K: "from-local",
      ONLY_BASE: "z",
      ONLY_LOCAL: "y",
    });
    expect(r.envFiles).toEqual([".env.local", ".env"]);
  });
});

describe("resolveCanonicalRoot", () => {
  it("returns the canonical repo root from a worktree", () => {
    initRepo(tmp);
    const wt = path.join(tmp, "..", `${path.basename(tmp)}-wt-canon`);
    execSync(`git worktree add -q "${wt}" -b feat-canon`, { cwd: tmp });
    try {
      // Normalize via realpath: macOS prepends /private/ to /tmp, and the
      // git output may or may not include that prefix depending on platform.
      const got = resolveCanonicalRoot(wt);
      expect(got).toBeTruthy();
      expect(fs.realpathSync(got!)).toBe(fs.realpathSync(tmp));
    } finally {
      execSync(`git worktree remove --force "${wt}"`, { cwd: tmp });
    }
  });
  it("returns null when not in a git checkout", () => {
    expect(resolveCanonicalRoot("/tmp")).toBeNull();
  });
});
