import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getAnalysisDir,
  getFramesDir,
  getAudioPath,
  removeAnalysisDir,
} from "@/lib/analysis/storage";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-analysis-test-"));
  vi.stubEnv("LIBI_HOME", tmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("analysis storage", () => {
  it("getAnalysisDir resolves to ~/.libi/storage/{pieceId}/_analysis/{fileId}", () => {
    const dir = getAnalysisDir("piece-1", "file-A");
    expect(dir).toBe(path.join(tmp, "storage", "piece-1", "_analysis", "file-A"));
  });

  it("getAnalysisDir uses _global for null pieceId", () => {
    const dir = getAnalysisDir(null, "file-A");
    expect(dir).toBe(path.join(tmp, "storage", "_global", "_analysis", "file-A"));
  });

  it("getFramesDir is the frames subfolder", () => {
    expect(getFramesDir("piece-1", "file-A")).toBe(
      path.join(tmp, "storage", "piece-1", "_analysis", "file-A", "frames"),
    );
  });

  it("getAudioPath is audio.wav inside the analysis dir", () => {
    expect(getAudioPath("piece-1", "file-A")).toBe(
      path.join(tmp, "storage", "piece-1", "_analysis", "file-A", "audio.wav"),
    );
  });

  it("removeAnalysisDir is idempotent on missing dir", () => {
    expect(() => removeAnalysisDir("piece-1", "file-A")).not.toThrow();
  });

  it("removeAnalysisDir wipes the folder", () => {
    const dir = getAnalysisDir("piece-1", "file-A");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "marker"), "x");
    removeAnalysisDir("piece-1", "file-A");
    expect(fs.existsSync(dir)).toBe(false);
  });
});
