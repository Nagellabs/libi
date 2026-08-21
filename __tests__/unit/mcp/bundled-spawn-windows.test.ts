/**
 * A bundled MCP must resolve to something Windows can actually spawn.
 *
 * npm's cmd-shim writes THREE files per bin on Windows: an extensionless
 * `<name>` that is a BASH script (for Git Bash/MSYS), plus `<name>.cmd` and
 * `<name>.ps1`. `resolveBundledSpawn` used a bare
 * `existsSync(node_modules/.bin/<name>)`, which the bash script satisfies — so
 * it returned a command `spawn()` cannot execute, and the `def.command`
 * fallback is a bare `npx` (i.e. `npx.cmd`), equally unspawnable without a
 * shell. Every npm-backed bundled MCP was therefore dead on Windows while the
 * resolver believed it had found the binary.
 *
 * `lib/agents/runtime-install.ts` already solved this for agent adapters; this
 * pins that the MCP resolver uses the same rule. Not reachable from macOS CI,
 * so the platform is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { value: p, configurable: true });

const PKG = "@kevinwatt/yt-dlp-mcp";
const BIN = "yt-dlp-mcp";
const VERSION = "1.2.3";

let home: string;
let binDir: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "libi-spawn-"));
  process.env.LIBI_HOME = home;
  const root = path.join(home, "node_modules-root");
  binDir = path.join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const pkgDir = path.join(root, "node_modules", ...PKG.split("/"));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version: VERSION }));
  vi.resetModules();
  vi.doMock("@/lib/libi-home", async () => {
    const actual = await vi.importActual<typeof import("@/lib/libi-home")>("@/lib/libi-home");
    return { ...actual, getLibiNodeModulesRoot: () => root };
  });
});

afterEach(() => {
  setPlatform(realPlatform);
  delete process.env.LIBI_HOME;
  rmSync(home, { recursive: true, force: true });
  vi.resetModules();
  vi.doUnmock("@/lib/libi-home");
});

const def = {
  id: "youtube-downloader",
  command: "npx",
  args: ["-y", PKG],
  npmPackage: PKG,
  pinnedVersion: VERSION,
  binName: BIN,
};

async function resolve() {
  const { resolveBundledSpawn } = await import("@/mcp/registry/local-bin-resolver");
  return resolveBundledSpawn(def as never);
}

describe("resolveBundledSpawn on Windows", () => {
  it("picks the .cmd shim, not the extensionless bash script", async () => {
    setPlatform("win32");
    // Exactly what npm writes: all three files.
    writeFileSync(path.join(binDir, BIN), "#!/bin/sh\n");
    writeFileSync(path.join(binDir, `${BIN}.cmd`), "@echo off\r\n");
    writeFileSync(path.join(binDir, `${BIN}.ps1`), "#\n");
    const r = await resolve();
    expect(r.source).toBe("local");
    expect(path.basename(r.command)).toBe(`${BIN}.cmd`);
  });

  it("does NOT resolve when only the extensionless bash shim exists", async () => {
    // The original bug. Falling back is correct-ish; returning an unspawnable
    // bash script as if it were the binary is not.
    setPlatform("win32");
    writeFileSync(path.join(binDir, BIN), "#!/bin/sh\n");
    const r = await resolve();
    expect(r.source).toBe("fallback");
    expect(path.basename(r.command)).not.toBe(BIN);
  });

  it("still uses the extensionless bin on Unix", async () => {
    setPlatform("darwin");
    writeFileSync(path.join(binDir, BIN), "#!/bin/sh\n", { mode: 0o755 });
    const r = await resolve();
    expect(r.source).toBe("local");
    expect(path.basename(r.command)).toBe(BIN);
  });

  it("falls back when the installed version does not match the pin", async () => {
    setPlatform("win32");
    writeFileSync(path.join(binDir, `${BIN}.cmd`), "@echo off\r\n");
    const root = path.join(home, "node_modules-root");
    writeFileSync(
      path.join(root, "node_modules", ...PKG.split("/"), "package.json"),
      JSON.stringify({ version: "9.9.9" }),
    );
    expect((await resolve()).source).toBe("fallback");
  });
});
