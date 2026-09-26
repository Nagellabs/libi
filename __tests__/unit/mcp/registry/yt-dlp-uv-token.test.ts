import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import {
  getCustomInstaller,
  YT_DLP_UV_TOKEN,
  YT_DLP_UV_REQUIREMENT,
  ytDlpTokenPath,
  ytDlpUvInstallArgs,
} from "@/mcp/registry/installers";
import { ytDlpLauncherPath } from "@/lib/video-download/launcher";
import { isWindows } from "@/lib/platform";

// The yt-dlp-uv installer's verify() reads getLibiBinDir() via a dynamic
// import; point it at a temp bin dir so we can fabricate wrapper + token state.
// Preserve the rest of the module (ensureLibiDirs et al. run at logger load).
let binDir: string;
vi.mock("@/lib/libi-home", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/libi-home")>()),
  getLibiBinDir: () => binDir,
}));

/**
 * `libi.download_video` failed part-way through large YouTube videos
 * ("Signature solving failed … 403"). The cause is the INSTALL, not the
 * download argv: libi installed bare `yt-dlp`, so `yt-dlp-ejs` — the
 * JS-challenge solver script — was absent and every `n` parameter went
 * unsolved. YouTube throttles those URLs and 403s them on refresh, which a
 * small clip finishes before and a 200 MB+ file does not.
 */
describe("yt-dlp uv install argv", () => {
  it("installs the [default] extra, which is what carries yt-dlp-ejs", () => {
    expect(YT_DLP_UV_REQUIREMENT).toBe("yt-dlp[default]");
    expect(ytDlpUvInstallArgs()).toEqual([
      "tool",
      "install",
      "yt-dlp[default]",
      "--reinstall",
      "--force",
      "--python",
      "3.12",
      "--with",
      "certifi",
    ]);
  });

  it("passes --force so a repair can replace a stale uv entry-point link whose venv is gone", () => {
    // Reproduced live: with uv/tools deleted but uv/tools-bin/yt-dlp still
    // linking into it, `uv tool install` refused with "Executable already
    // exists: yt-dlp (use --force to overwrite)" and the repair could not run.
    expect(ytDlpUvInstallArgs()).toContain("--force");
  });

  it("keeps --reinstall so a token bump actually replaces the existing venv", () => {
    // Without it `uv tool install` no-ops on an existing install, and every
    // machine that already has a bare yt-dlp keeps its solver-less one.
    expect(ytDlpUvInstallArgs()).toContain("--reinstall");
  });

  it("bumped the token past the pre-[default] install", () => {
    // Existing installs are bare `yt-dlp`; only a token they do not match
    // makes verify() return null and force the repair.
    expect(YT_DLP_UV_TOKEN).not.toBe("yt-dlp-uv@2026-07-06");
    expect(YT_DLP_UV_TOKEN).toMatch(/^yt-dlp-uv@\d{4}-\d{2}-\d{2}$/);
  });
});

describe("yt-dlp-uv installer verify() — token gate (force-rebuild lever)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ytdlp-token-"));
    binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const installer = () => getCustomInstaller("yt-dlp-uv")!;
  /** The launcher's path as the product names it: `bin/yt-dlp`, or `bin/yt-dlp.cmd` on Windows. */
  const launcher = () => ytDlpLauncherPath();
  /** A launcher in the shape libi writes on this host (`installYtDlpViaUv`: a bash wrapper, or the .cmd shim on
   *  Windows), exec'ing an entry point that EXISTS — verify() also requires the target (see the dead-target case). */
  const writeWrapper = (target = path.join(tmp, "uv", "tools", "yt-dlp", "bin", "yt-dlp")) => {
    if (!target.includes("missing")) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    }
    const text = isWindows()
      ? `@echo off\r\necho %*| findstr /I /C:"playlist" >nul\r\nif errorlevel 1 (\r\n  "${target}" --no-playlist %*\r\n) else (\r\n  "${target}" %*\r\n)\r\n`
      : `#!/bin/bash\nexec "${target}" --no-playlist "$@"\n`;
    fs.writeFileSync(launcher(), text, { mode: 0o755 });
  };

  it("returns null when the wrapper is absent (fresh install)", async () => {
    expect(await installer().verify()).toBeNull();
  });

  it("returns null when the wrapper exists but there is NO token file (pre-token install)", async () => {
    writeWrapper();
    expect(await installer().verify()).toBeNull();
  });

  it("returns null when the token file does not match (a bumped token forces reinstall)", async () => {
    writeWrapper();
    fs.writeFileSync(ytDlpTokenPath(binDir), "yt-dlp-uv@1999-01-01", "utf-8");
    expect(await installer().verify()).toBeNull();
  });

  it("returns the wrapper path when the token matches the current YT_DLP_UV_TOKEN", async () => {
    writeWrapper();
    fs.writeFileSync(ytDlpTokenPath(binDir), YT_DLP_UV_TOKEN, "utf-8");
    expect(await installer().verify()).toBe(launcher());
  });

  it("tolerates surrounding whitespace in the token file", async () => {
    writeWrapper();
    fs.writeFileSync(ytDlpTokenPath(binDir), `\n  ${YT_DLP_UV_TOKEN}\n`, "utf-8");
    expect(await installer().verify()).toBe(launcher());
  });

  it("returns null when the token matches but the launcher's target is gone (a deleted worktree's path)", async () => {
    writeWrapper(path.join(tmp, "worktrees", "missing", "uv", "tools", "yt-dlp", "bin", "yt-dlp"));
    fs.writeFileSync(ytDlpTokenPath(binDir), YT_DLP_UV_TOKEN, "utf-8");
    expect(await installer().verify()).toBeNull();
  });

  it("returns null for a launcher libi did not write (no exec target to check)", async () => {
    const foreign = isWindows() ? "@echo off\r\nyt-dlp %*\r\n" : "#!/bin/bash\nexec yt-dlp \"$@\"\n";
    fs.writeFileSync(launcher(), foreign, { mode: 0o755 });
    fs.writeFileSync(ytDlpTokenPath(binDir), YT_DLP_UV_TOKEN, "utf-8");
    expect(await installer().verify()).toBeNull();
  });

  it("logs an unusable launcher once per cause, and again after it was healthy in between", async () => {
    const { serverLogger } = await import("@/lib/logger");
    const info = vi.spyOn(serverLogger, "info");
    const unusable = () =>
      info.mock.calls.filter((c) => (c[0] as { op?: string })?.op === "launcher_unusable").length;
    const dead = path.join(tmp, "worktrees", "missing-again", "uv", "tools", "yt-dlp", "bin", "yt-dlp");
    fs.writeFileSync(ytDlpTokenPath(binDir), YT_DLP_UV_TOKEN, "utf-8");
    try {
      writeWrapper(dead);
      await installer().verify();
      await installer().verify();
      expect(unusable()).toBe(1); // polled twice, said once
      writeWrapper(); // repaired
      expect(await installer().verify()).toBe(launcher());
      writeWrapper(dead); // the SAME break again
      await installer().verify();
      expect(unusable()).toBe(2);
    } finally {
      info.mockRestore();
    }
  });
});
