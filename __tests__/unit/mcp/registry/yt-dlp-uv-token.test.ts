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
      "--python",
      "3.12",
      "--with",
      "certifi",
    ]);
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
  const writeWrapper = () =>
    fs.writeFileSync(path.join(binDir, "yt-dlp"), "#!/bin/bash\nexec yt-dlp \"$@\"\n", {
      mode: 0o755,
    });

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
    expect(await installer().verify()).toBe(path.join(binDir, "yt-dlp"));
  });

  it("tolerates surrounding whitespace in the token file", async () => {
    writeWrapper();
    fs.writeFileSync(ytDlpTokenPath(binDir), `\n  ${YT_DLP_UV_TOKEN}\n`, "utf-8");
    expect(await installer().verify()).toBe(path.join(binDir, "yt-dlp"));
  });
});
