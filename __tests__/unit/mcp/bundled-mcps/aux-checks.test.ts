import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkBinary, checkYtDlp } from "@/mcp/bundled-mcps/aux-checks";

describe("checkBinary", () => {
  it("returns ok=true with path + version when binary exists and runs fast", async () => {
    const result = await checkBinary("echo");
    expect(result.name).toBe("echo");
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/^\/|^\w/); // a path
  });

  it("returns ok=false when binary not found", async () => {
    const result = await checkBinary("definitely-not-a-real-binary-9876");
    expect(result.ok).toBe(false);
    expect(result.detail.toLowerCase()).toContain("not found");
  });
});

/**
 * checkYtDlp — diagnose_mcp's yt-dlp check reads libi's own launcher
 * (lib/video-download/launcher.ts), so on Windows, where the launcher is
 * `yt-dlp.cmd` and `execFile` cannot run it, it no longer always says
 * "not found on PATH".
 */
describe("checkYtDlp", () => {
  const savedHome = process.env.LIBI_HOME;
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-aux-ytdlp-"));
    process.env.LIBI_HOME = home;
    fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** An entry point that answers `--version` the way yt-dlp does. */
  function writeEntry(name: string): string {
    const entry = path.join(home, "uv", "tools", "yt-dlp", "Scripts", name);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "#!/bin/sh\necho 2026.09.20\n", { mode: 0o755 });
    return entry;
  }

  // The entry is a shell script standing in for the `.exe` trampoline, so it
  // only runs on a posix host; the platform itself is pinned to win32.
  it.skipIf(process.platform === "win32")(
    "on Windows reads yt-dlp.cmd and runs the entry point it names",
    async () => {
      vi.spyOn(os, "platform").mockReturnValue("win32");
      const entry = writeEntry("yt-dlp.exe");
      fs.writeFileSync(
        path.join(home, "bin", "yt-dlp.cmd"),
        `@echo off\r\necho %*| findstr /I /C:"playlist" >nul\r\nif errorlevel 1 (\r\n` +
          `  "${entry}" --no-playlist %*\r\n) else (\r\n  "${entry}" %*\r\n)\r\n`,
      );
      const result = await checkYtDlp();
      expect(result).toMatchObject({ name: "yt-dlp", ok: true });
      expect(result.detail).toContain("yt-dlp.cmd");
      expect(result.detail).toContain("2026.09.20");
    },
  );

  it("on Windows with no launcher says it is not installed yet, not 'not found on PATH'", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    const result = await checkYtDlp();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^not installed yet \(no .*yt-dlp\.cmd\)/);
    expect(result.detail).toContain("Agents → Libi MCP → Video download");
    expect(result.detail).not.toContain("PATH");
  });

  it("names a launcher whose target is gone", async () => {
    const result = await checkYtDlp(() => ({
      ok: false,
      launcher: "/h/.libi/bin/yt-dlp",
      reason: "target_missing",
      target: "/gone/uv/tools/yt-dlp/bin/yt-dlp",
    }));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("/gone/uv/tools/yt-dlp/bin/yt-dlp, which no longer exists");
  });

  // UV-1 (G2 review M9): a cold first run of the Windows `.exe` trampoline (pyc compile, a Defender scan) can take
  // several seconds on a healthy install. 3 s called that "too slow"; the bound is 10 s now.
  it.skipIf(process.platform === "win32")(
    "a slow cold start (3.5 s) still answers: the bound is 10 s, not 3",
    async () => {
      const entry = path.join(home, "slow-yt-dlp");
      fs.writeFileSync(entry, "#!/bin/sh\nsleep 3.5\necho 2026.09.20\n", { mode: 0o755 });
      const result = await checkYtDlp(() => ({ ok: true, launcher: "/h/.libi/bin/yt-dlp", target: entry }));
      expect(result).toMatchObject({ name: "yt-dlp", ok: true });
      expect(result.detail).toContain("2026.09.20");
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")("past the bound it says how long it waited", async () => {
    const entry = path.join(home, "hung-yt-dlp");
    fs.writeFileSync(entry, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    const result = await checkYtDlp(() => ({ ok: true, launcher: "/h/.libi/bin/yt-dlp", target: entry }), 200);
    expect(result).toMatchObject({ ok: false, detail: `${entry} timed out after 200ms — startup too slow` });
  });

  it.skipIf(process.platform === "win32")("reports an entry point that does not run", async () => {
    const entry = path.join(home, "not-executable");
    fs.writeFileSync(entry, "x", { mode: 0o644 });
    const result = await checkYtDlp(() => ({ ok: true, launcher: "/h/.libi/bin/yt-dlp", target: entry }));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("failed to run");
  });
});
