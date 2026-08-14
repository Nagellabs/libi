import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-analyze-i-"));
  process.env.LIBI_HOME = tmp;
  vi.resetModules();
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("isMusicAnalysisInstalled", () => {
  it("returns false when the token file is missing", async () => {
    const { isMusicAnalysisInstalled } = await import("@/lib/music/analyze-install");
    expect(isMusicAnalysisInstalled()).toBe(false);
  });

  it("returns true when the token matches the current env signature", async () => {
    const { musicAnalysisEnvSignature } = await import("@/lib/music/analyze");
    const { writeInstallToken } = await import("@/lib/uv-env/install-token");
    writeInstallToken(".libi-music-analysis.install-token", musicAnalysisEnvSignature());
    const { isMusicAnalysisInstalled } = await import("@/lib/music/analyze-install");
    expect(isMusicAnalysisInstalled()).toBe(true);
  });

  it("returns false when the token contains a stale signature", async () => {
    const { writeInstallToken } = await import("@/lib/uv-env/install-token");
    writeInstallToken(".libi-music-analysis.install-token", "stale-signature-123");
    const { isMusicAnalysisInstalled } = await import("@/lib/music/analyze-install");
    expect(isMusicAnalysisInstalled()).toBe(false);
  });

  it("writeMusicAnalysisToken writes the current signature", async () => {
    const { musicAnalysisEnvSignature } = await import("@/lib/music/analyze");
    const { writeMusicAnalysisToken } = await import("@/lib/music/analyze-install");
    writeMusicAnalysisToken();
    const onDisk = fs
      .readFileSync(path.join(tmp, ".libi-music-analysis.install-token"), "utf-8")
      .trim();
    expect(onDisk).toBe(musicAnalysisEnvSignature());
  });
});
