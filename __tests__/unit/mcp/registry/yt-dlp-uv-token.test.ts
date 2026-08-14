import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import {
  getCustomInstaller,
  YT_DLP_UV_TOKEN,
  ytDlpTokenPath,
} from "@/mcp/registry/installers";

// The yt-dlp-uv installer's verify() reads getLibiBinDir() via a dynamic
// import; point it at a temp bin dir so we can fabricate wrapper + token state.
// Preserve the rest of the module (ensureLibiDirs et al. run at logger load).
let binDir: string;
vi.mock("@/lib/libi-home", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/libi-home")>()),
  getLibiBinDir: () => binDir,
}));

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
