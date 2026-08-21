/**
 * yt-dlp must install and verify on Windows, because failing to is fatal.
 *
 * yt-dlp is `installFlow: "tier-1"` (mcp/registry/bundled.ts). `installSingleDep`
 * RETHROWS on failure, and `category-a.ts` turns that into an
 * `InstallPhaseError("binary-install", …)` which aborts boot. So a yt-dlp
 * install bug is not "one MCP is down" — the app never starts at all.
 *
 * Two Windows-only bugs did exactly that, and neither is reachable from macOS
 * CI, so they are pinned here with the platform stubbed:
 *
 *   1. The uv venv entry point was looked up under `bin/` on every platform.
 *      A PEP-405 venv uses `Scripts\` on Windows, so the lookup threw
 *      "expected entry point not found" after a multi-minute uv download.
 *   2. `verify()` looked for an extensionless `yt-dlp`, but the installer's
 *      win32 branch writes a `yt-dlp.cmd` shim (symlinks need admin on
 *      Windows). verify() therefore returned null forever: the install
 *      succeeded and was then declared failed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "libi-ytdlp-"));
  mkdirSync(path.join(home, "bin"), { recursive: true });
  process.env.LIBI_HOME = home;
  vi.resetModules();
});
afterEach(() => {
  setPlatform(realPlatform);
  delete process.env.LIBI_HOME;
  rmSync(home, { recursive: true, force: true });
  vi.resetModules();
});

/** Write the shim the installer would write, plus a current token file. */
async function seed(filename: string) {
  const { YT_DLP_UV_TOKEN, ytDlpTokenPath } = await import("@/mcp/registry/installers");
  const binDir = path.join(home, "bin");
  writeFileSync(path.join(binDir, filename), "@echo off\r\n");
  writeFileSync(ytDlpTokenPath(binDir), YT_DLP_UV_TOKEN);
}

describe("yt-dlp verify() matches what the installer writes", () => {
  it("finds the .cmd shim on Windows", async () => {
    setPlatform("win32");
    await seed("yt-dlp.cmd");
    const { getCustomInstaller } = await import("@/mcp/registry/installers");
    const found = await getCustomInstaller("yt-dlp-uv")!.verify();
    expect(found, "verify() must see the yt-dlp.cmd the win32 installer writes")
      .toBe(path.join(home, "bin", "yt-dlp.cmd"));
  });

  it("does NOT accept an extensionless wrapper as the Windows install", async () => {
    // The original bug, inverted: on Windows the extensionless name is not
    // what gets written, so finding one must not count as installed.
    setPlatform("win32");
    await seed("yt-dlp");
    const { getCustomInstaller } = await import("@/mcp/registry/installers");
    expect(await getCustomInstaller("yt-dlp-uv")!.verify()).toBeNull();
  });

  it("still finds the extensionless wrapper on Unix", async () => {
    setPlatform("darwin");
    await seed("yt-dlp");
    const { getCustomInstaller } = await import("@/mcp/registry/installers");
    expect(await getCustomInstaller("yt-dlp-uv")!.verify())
      .toBe(path.join(home, "bin", "yt-dlp"));
  });

  it("returns null when nothing is installed, on either platform", async () => {
    for (const p of ["win32", "darwin"] as const) {
      setPlatform(p);
      vi.resetModules();
      const { getCustomInstaller } = await import("@/mcp/registry/installers");
      expect(await getCustomInstaller("yt-dlp-uv")!.verify(), p).toBeNull();
    }
  });
});

describe("the uv venv entry point uses the platform's layout", () => {
  it("resolves Scripts\\ on Windows and bin/ elsewhere", () => {
    // Asserted on source: the lookup sits inside a multi-minute async installer
    // that shells out to uv, so there is no seam to call it through. The
    // invariant that matters is that the DIRECTORY is chosen per-platform, not
    // just the filename — which is exactly what was wrong.
    const src = readFileSync("mcp/registry/dependency-manager.ts", "utf8");
    expect(src).toContain(
      'const venvBinDir = process.platform === "win32" ? "Scripts" : "bin";',
    );
    // Neither the yt-dlp entry point nor the python bin may hardcode "bin".
    expect(src).not.toMatch(/"yt-dlp",\s*\n\s*"bin",/);
    const uses = src.match(/venvBinDir,/g) ?? [];
    expect(uses.length, "both ytDlpEntry and pythonBin must use it").toBe(2);
  });
});
