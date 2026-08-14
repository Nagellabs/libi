import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  WHISPER_MODELS,
  DEFAULT_WHISPER_MODEL,
  resolveWhisperModel,
  hfCacheDirName,
  whisperModelsDir,
  isWhisperModelInstalled,
  listWhisperModelStatus,
} from "@/lib/whisper/models";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-whisper-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("whisper model catalog", () => {
  it("has the five expected models and a small default", () => {
    expect(WHISPER_MODELS.map((m) => m.id)).toEqual([
      "tiny",
      "base",
      "small",
      "medium",
      "large-v3",
    ]);
    expect(DEFAULT_WHISPER_MODEL).toBe("small");
  });

  it("resolveWhisperModel falls back to the default", () => {
    expect(resolveWhisperModel(undefined)).toBe("small");
    expect(resolveWhisperModel("medium")).toBe("medium");
    expect(() => resolveWhisperModel("bogus")).toThrow(/unknown whisper model/i);
  });

  it("hfCacheDirName follows the huggingface_hub convention", () => {
    expect(hfCacheDirName("small")).toBe(
      "models--Systran--faster-whisper-small",
    );
    expect(hfCacheDirName("large-v3")).toBe(
      "models--Systran--faster-whisper-large-v3",
    );
  });

  it("isWhisperModelInstalled is false until a snapshots dir with content exists", () => {
    expect(isWhisperModelInstalled("small")).toBe(false);
    const snap = path.join(
      whisperModelsDir(),
      hfCacheDirName("small"),
      "snapshots",
      "abc123",
    );
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, "model.bin"), "x");
    expect(isWhisperModelInstalled("small")).toBe(true);
  });

  it("listWhisperModelStatus marks installed + default flags", () => {
    const snap = path.join(
      whisperModelsDir(),
      hfCacheDirName("small"),
      "snapshots",
      "r1",
    );
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, "model.bin"), "x");
    const status = listWhisperModelStatus();
    const small = status.find((s) => s.id === "small")!;
    const tiny = status.find((s) => s.id === "tiny")!;
    expect(small.installed).toBe(true);
    expect(small.isDefault).toBe(true);
    expect(tiny.installed).toBe(false);
    expect(tiny.isDefault).toBe(false);
  });
});
