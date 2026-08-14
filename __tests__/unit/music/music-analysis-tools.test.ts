import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-mat-"));
  process.env.LIBI_HOME = tmp;
  vi.resetModules();
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("musicDetectBeats", () => {
  it("returns needs_install when the analyze env marker is missing", async () => {
    const { musicDetectBeats } = await import("@/mcp/tools/music-analysis-tools");
    const r = await musicDetectBeats({ fileId: "f1" });
    expect(r.success).toBe(false);
    expect(r.data?.status).toBe("needs_install");
    expect(r.data?.hint).toMatch(/get_install_plan/);
  });

  it("returns the parsed beats envelope when the analyzer succeeds (test seam)", async () => {
    const analyzeInstall = await import("@/lib/music/analyze-install");
    vi.spyOn(analyzeInstall, "isMusicAnalysisInstalled").mockReturnValue(true);
    const fileTools = await import("@/mcp/tools/file-tools");
    vi.spyOn(fileTools, "getFileLocalPath").mockResolvedValue("/some/track.wav");
    const fakeAnalyze = vi.fn().mockResolvedValue({
      tempo: 89,
      tempoConfidence: 0.9,
      beatTimes: [0.1, 0.6],
      onsetTimes: [0.05, 0.6],
      durationSeconds: 12,
      truncated: false,
    });
    const { musicDetectBeats } = await import("@/mcp/tools/music-analysis-tools");
    const r = await musicDetectBeats({ fileId: "f1" }, undefined, fakeAnalyze);
    expect(r.success).toBe(true);
    expect(r.data?.tempo).toBe(89);
    expect(r.data?.beatTimes).toEqual([0.1, 0.6]);
    expect(fakeAnalyze).toHaveBeenCalledWith(
      expect.objectContaining({ inPath: "/some/track.wav" }),
    );
  });

  it("returns file_not_found when the file id can't be resolved", async () => {
    const analyzeInstall = await import("@/lib/music/analyze-install");
    vi.spyOn(analyzeInstall, "isMusicAnalysisInstalled").mockReturnValue(true);
    const fileTools = await import("@/mcp/tools/file-tools");
    vi.spyOn(fileTools, "getFileLocalPath").mockResolvedValue(null);
    const { musicDetectBeats } = await import("@/mcp/tools/music-analysis-tools");
    const r = await musicDetectBeats({ fileId: "missing" });
    expect(r.success).toBe(false);
    expect(r.data?.status).toBe("file_not_found");
  });
});

describe("musicProfile", () => {
  it("requires suggestedPrompt to be non-empty on success", async () => {
    const analyzeInstall = await import("@/lib/music/analyze-install");
    vi.spyOn(analyzeInstall, "isMusicAnalysisInstalled").mockReturnValue(true);
    const fileTools = await import("@/mcp/tools/file-tools");
    vi.spyOn(fileTools, "getFileLocalPath").mockResolvedValue("/x.wav");
    const fakeAnalyze = vi.fn().mockResolvedValue({
      durationSeconds: 12,
      tempo: 89,
      tempoConfidence: 0.9,
      keyEstimate: { tonic: "A", mode: "minor", confidence: 0.7 },
      energyMean: 0.3,
      brightnessMean: 0.4,
      percussiveness: 0.5,
      loudnessLufs: -14,
      descriptors: ["moderate tempo", "A minor", "balanced timbre", "moderate energy"],
      suggestedPrompt: "A moderate tempo piece at 89 BPM in A minor.",
      truncated: false,
    });
    const { musicProfile } = await import("@/mcp/tools/music-analysis-tools");
    const r = await musicProfile({ fileId: "f1" }, undefined, fakeAnalyze);
    expect(r.success).toBe(true);
    expect(r.data?.suggestedPrompt).toMatch(/89/);
  });
});

describe("musicInstallAnalysisDeps", () => {
  it("writes the install token on a successful install", async () => {
    const installer = vi.fn().mockResolvedValue(undefined);
    const { musicInstallAnalysisDeps } = await import("@/mcp/tools/music-analysis-tools");
    const r = await musicInstallAnalysisDeps({}, undefined, installer);
    expect(r.success).toBe(true);
    expect(r.data?.status).toBe("installed");
    expect(installer).toHaveBeenCalledTimes(1);
  });

  it("returns install_failed with the formatted error when the installer throws", async () => {
    const installer = vi.fn().mockRejectedValue(new Error("uv whoopsie"));
    const { musicInstallAnalysisDeps } = await import("@/mcp/tools/music-analysis-tools");
    const r = await musicInstallAnalysisDeps({}, undefined, installer);
    expect(r.success).toBe(false);
    expect(r.data?.status).toBe("install_failed");
    expect(r.data?.hint).toMatch(/uv whoopsie/);
  });
});
