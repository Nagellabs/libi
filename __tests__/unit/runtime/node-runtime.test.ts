/**
 * `lib/runtime/node-runtime.ts` — the Node runtime libi spawns the libi MCP
 * and the Claude ACP adapter with.
 *
 * Defect D3: the MCP spawn used a bare `command: "node"`, which requires node
 * on PATH. A Finder-launched packaged app has launchd's minimal PATH, and the
 * hardcoded fallback in `electron/path-bootstrap.ts` contains no node on a
 * machine whose node lives in a version manager.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  managedNodePath,
  nodeArchiveTarget,
  nodeBinaryName,
  resolveNodeCommand,
  findSystemNode,
  ensureNodeRuntime,
  PINNED_NODE_VERSION,
  MIN_NODE_MAJOR,
  NODE_DOWNLOAD_MAX_BYTES,
} from "@/lib/runtime/node-runtime";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.LIBI_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-node-rt-"));
  process.env.LIBI_HOME = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("resolveNodeCommand", () => {
  it("falls back to the bare name when nothing is provisioned", () => {
    expect(resolveNodeCommand()).toBe(nodeBinaryName());
  });

  it("returns the managed absolute path once it exists", () => {
    const managed = managedNodePath();
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveNodeCommand()).toBe(managed);
    expect(path.isAbsolute(resolveNodeCommand())).toBe(true);
  });

  it("ignores a DANGLING managed symlink rather than handing out a broken path", () => {
    const managed = managedNodePath();
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.symlinkSync(path.join(tmpHome, "gone", "node"), managed);
    // existsSync follows the link, so a link to nowhere must not win.
    expect(resolveNodeCommand()).toBe(nodeBinaryName());
  });
});

describe("nodeArchiveTarget", () => {
  it("builds the official URL + inner path per platform", () => {
    const mac = nodeArchiveTarget("darwin", "arm64");
    expect(mac?.url).toBe(
      `https://nodejs.org/dist/${PINNED_NODE_VERSION}/node-${PINNED_NODE_VERSION}-darwin-arm64.tar.gz`,
    );
    expect(mac?.innerPath).toBe(
      path.join(`node-${PINNED_NODE_VERSION}-darwin-arm64`, "bin", "node"),
    );
    expect(mac?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const win = nodeArchiveTarget("win32", "x64");
    expect(win?.url).toMatch(/\.zip$/);
    expect(win?.innerPath).toBe(path.join(`node-${PINNED_NODE_VERSION}-win-x64`, "node.exe"));

    const linux = nodeArchiveTarget("linux", "x64");
    expect(linux?.url).toMatch(/-linux-x64\.tar\.gz$/);
  });

  it("returns null for a platform/arch with no pinned build (so we never fabricate a URL)", () => {
    expect(nodeArchiveTarget("darwin", "mips")).toBeNull();
    expect(nodeArchiveTarget("aix" as NodeJS.Platform, "ppc64")).toBeNull();
  });

  it("pins a sha256 for every supported platform/arch it advertises", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
      ["win32", "arm64"],
      ["win32", "x64"],
    ] as const) {
      const t = nodeArchiveTarget(platform, arch);
      expect(t, `${platform}-${arch}`).not.toBeNull();
      expect(t!.sha256, `${platform}-${arch}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("findSystemNode", () => {
  it("never returns the libi-managed copy (it would symlink itself)", () => {
    const managed = managedNodePath();
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, "#!/bin/sh\necho v99.0.0\n", { mode: 0o755 });
    expect(findSystemNode([path.dirname(managed)])).toBeNull();
  });

  it("accepts a node whose major version is high enough, returning its realpath", () => {
    const binDir = path.join(tmpHome, "fake-node-install", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const real = path.join(binDir, nodeBinaryName());
    fs.writeFileSync(real, `#!/bin/sh\necho v${MIN_NODE_MAJOR}.1.0\n`, { mode: 0o755 });
    // A version-manager-style shim directory that merely links to the real one.
    const shimDir = path.join(tmpHome, "shim-1234", "bin");
    fs.mkdirSync(shimDir, { recursive: true });
    fs.symlinkSync(real, path.join(shimDir, nodeBinaryName()));

    // The realpath, not the ephemeral shim — pinning the shim is what the
    // gate flagged as fragile about the cached fnm_multishells PATH.
    expect(findSystemNode([shimDir])).toBe(fs.realpathSync(real));
  });

  it("rejects a node whose major version is below the minimum", () => {
    const binDir = path.join(tmpHome, "old", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const old = path.join(binDir, nodeBinaryName());
    fs.writeFileSync(old, `#!/bin/sh\necho v${MIN_NODE_MAJOR - 2}.0.0\n`, { mode: 0o755 });
    expect(findSystemNode([binDir])).toBeNull();
  });

  it("skips directories that do not exist without throwing", () => {
    expect(findSystemNode([path.join(tmpHome, "nope")])).toBeNull();
  });

  it("honours an acceptMajor predicate", () => {
    const binDir = path.join(tmpHome, "n25", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, nodeBinaryName()), "#!/bin/sh\necho v25.0.0\n", {
      mode: 0o755,
    });
    expect(findSystemNode([binDir], (m) => m === 25)).not.toBeNull();
    expect(findSystemNode([binDir], (m) => m === 24)).toBeNull();
  });
});

/**
 * A packaged runtime can only serve the plain-node MCP child a major it ships a
 * better-sqlite3 sidecar for. `findSystemNode` filtered on `MIN_NODE_MAJOR`
 * with NO upper bound, while the bundle ships 20–24 — so a mainstream macOS
 * machine (Homebrew's current `node` is 25.x) got a linked Node 25 that could
 * not open the database, behind an entirely healthy-looking app.
 */
describe("ensureNodeRuntime — sidecar-covered majors", () => {
  /** A build dir shaped like a packaged runtime: Electron default + sidecars. */
  function packagedBuildDir(majors: number[]): string {
    const dir = path.join(tmpHome, "bsql-build");
    fs.mkdirSync(path.join(dir, "Release"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Release", "better_sqlite3.node"), "electron");
    for (const m of majors) {
      fs.mkdirSync(path.join(dir, `Release-node-${m}`), { recursive: true });
      fs.writeFileSync(
        path.join(dir, `Release-node-${m}`, "better_sqlite3.node"),
        "node",
      );
    }
    return dir;
  }

  function fakeNode(name: string, major: number): string {
    const binDir = path.join(tmpHome, name, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, nodeBinaryName()), `#!/bin/sh\necho v${major}.0.0\n`, {
      mode: 0o755,
    });
    return binDir;
  }

  afterEach(() => {
    delete process.env.LIBI_SQLITE_BINDING_DIR;
  });

  it("refuses to link a system node with no matching sidecar", async () => {
    process.env.LIBI_SQLITE_BINDING_DIR = packagedBuildDir([20, 22, 24]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const result = await ensureNodeRuntime([fakeNode("homebrew", 25)]);
    // Linking node 25 would "succeed" and leave every DB-backed libi.* tool
    // dead; falling through to the pinned download is the correct choice, and
    // failing honestly when that download can't happen is better than lying.
    expect(result.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("links a system node whose major IS covered", async () => {
    process.env.LIBI_SQLITE_BINDING_DIR = packagedBuildDir([20, 22, 24]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await ensureNodeRuntime([fakeNode("covered", 24)]);
    expect(result).toMatchObject({ ok: true, source: "linked-system" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // The npx layout: npm compiled build/Release for whatever node ran the
  // install, so constraining the interpreter would create the same mismatch in
  // reverse. No sidecars ⇒ no constraint.
  it("imposes no constraint when there are no sidecars at all", async () => {
    const dir = path.join(tmpHome, "npx-build", "Release");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "better_sqlite3.node"), "npm-built");
    process.env.LIBI_SQLITE_BINDING_DIR = path.dirname(dir);
    const result = await ensureNodeRuntime([fakeNode("any", 25)]);
    expect(result).toMatchObject({ ok: true, source: "linked-system" });
  });

  // Heals a machine that linked an uncovered node before this check existed,
  // rather than leaving it broken until someone deletes the file by hand.
  it("re-resolves an already-managed node whose major is not covered", async () => {
    process.env.LIBI_SQLITE_BINDING_DIR = packagedBuildDir([24]);
    const managed = managedNodePath();
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, "#!/bin/sh\necho v25.0.0\n", { mode: 0o755 });

    const result = await ensureNodeRuntime([fakeNode("covered", 24)]);
    expect(result).toMatchObject({ ok: true, source: "linked-system" });
  });
});

describe("ensureNodeRuntime", () => {
  it("links a discovered system node into <LIBI_HOME>/bin and never downloads", async () => {
    // M9: the original test had no fetch spy, so the "never downloads" half
    // of its own name was unasserted — it would have passed identically even
    // if a code change made this path fetch the pinned archive anyway.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const binDir = path.join(tmpHome, "sys", "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const sys = path.join(binDir, nodeBinaryName());
      fs.writeFileSync(sys, `#!/bin/sh\necho v${MIN_NODE_MAJOR}.0.0\n`, { mode: 0o755 });

      const result = await ensureNodeRuntime([binDir]);
      expect(result).toEqual({
        ok: true,
        path: managedNodePath(),
        source: "linked-system",
      });
      expect(fs.realpathSync(managedNodePath())).toBe(fs.realpathSync(sys));
      // And now the spawn path is PATH-independent.
      expect(resolveNodeCommand()).toBe(managedNodePath());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("is idempotent — a second run keeps the existing managed copy", async () => {
    const binDir = path.join(tmpHome, "sys", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, nodeBinaryName()), `#!/bin/sh\necho v${MIN_NODE_MAJOR}.0.0\n`, {
      mode: 0o755,
    });
    await ensureNodeRuntime([binDir]);
    const second = await ensureNodeRuntime([binDir]);
    expect(second).toEqual({
      ok: true,
      path: managedNodePath(),
      source: "already-managed",
    });
  });

  it("repairs a dangling managed symlink instead of leaving the app unspawnable", async () => {
    const managed = managedNodePath();
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.symlinkSync(path.join(tmpHome, "uninstalled", "node"), managed);

    const binDir = path.join(tmpHome, "sys", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, nodeBinaryName()), `#!/bin/sh\necho v${MIN_NODE_MAJOR}.0.0\n`, {
      mode: 0o755,
    });
    const result = await ensureNodeRuntime([binDir]);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(managed)).toBe(true);
  });

  it("installs atomically via a copy fallback when symlinking is unavailable (M2)", async () => {
    const binDir = path.join(tmpHome, "sys", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const sys = path.join(binDir, nodeBinaryName());
    fs.writeFileSync(sys, `#!/bin/sh\necho v${MIN_NODE_MAJOR}.0.0\n`, { mode: 0o755 });

    const symlinkSpy = vi.spyOn(fs, "symlinkSync").mockImplementation(() => {
      throw new Error("EPERM: operation not permitted, symlink");
    });
    try {
      const result = await ensureNodeRuntime([binDir]);
      expect(result).toEqual({ ok: true, path: managedNodePath(), source: "linked-system" });
      // A real regular file, not a symlink — proves the copy fallback ran
      // rather than a (now-failing) symlink.
      expect(fs.lstatSync(managedNodePath()).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(managedNodePath(), "utf8")).toContain(`v${MIN_NODE_MAJOR}.0.0`);
      // No abandoned `.tmp-<pid>-...` sibling left behind by the atomic
      // write-then-rename — a crash mid-copy would otherwise leave one.
      const siblings = fs.readdirSync(path.dirname(managedNodePath()));
      expect(siblings.some((f) => f.includes(".tmp-"))).toBe(false);
    } finally {
      symlinkSpy.mockRestore();
    }
  });
});

describe("ensureNodeRuntime download safety (I2)", () => {
  it("bounds the fetch with an AbortSignal timeout and rejects a declared size over the cap without reading the body", async () => {
    const target = nodeArchiveTarget();
    if (!target) {
      // Unsupported platform/arch for the machine running this test suite —
      // nothing to exercise.
      return;
    }
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      // The fetch timeout (I2) — a real timeout, not decoration.
      expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
      return new Response(null, {
        status: 200,
        headers: { "content-length": String(NODE_DOWNLOAD_MAX_BYTES + 1) },
      });
    });
    try {
      // No search dirs → findSystemNode finds nothing → falls through to the
      // (mocked) download path.
      const result = await ensureNodeRuntime([]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/exceeds/);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // B2: the download used a 60s TOTAL `AbortSignal.timeout` and no retry. The
  // pinned archives are 37–57 MB, so that made ~5–7.6 Mbit/s a hard floor on
  // who could provision a node at all — below it the fetch aborted every
  // single time, on a link that worked fine. The stall guard's deadline is
  // idle time, and it retries, so a flaky-but-alive connection now finishes.
  it("retries a dropped connection instead of failing the whole provision", async () => {
    const target = nodeArchiveTarget();
    if (!target) return;
    let calls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    try {
      // Fails on the sha (the body is not a real archive) — but only AFTER a
      // second attempt happened, which is the property under test.
      const result = await ensureNodeRuntime([]);
      expect(result.ok).toBe(false);
      expect(calls, "a transport error must be retried, not fatal").toBeGreaterThan(1);
    } finally {
      fetchSpy.mockRestore();
    }
  }, 20_000);
});
