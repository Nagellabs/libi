import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  KOKORO_VOICES,
  DEFAULT_VOICE,
  KOKORO_ONNX_VERSION,
  KOKORO_MODEL_URL,
  KOKORO_VOICES_URL,
  resolveVoice,
  voiceLang,
  ttsModelsDir,
  kokoroModelPaths,
  isKokoroModelInstalled,
  listVoiceStatus,
} from "@/lib/tts/voices";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tts-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("kokoro voice catalog", () => {
  it("has a stable default and known voices", () => {
    expect(DEFAULT_VOICE).toBe("af_heart");
    const ids = KOKORO_VOICES.map((v) => v.id);
    expect(ids).toContain("af_heart");
    expect(ids).toContain("am_adam");
    expect(ids).toContain("bf_emma");
    expect(ids).toContain("bm_george");
    expect(new Set(ids).size).toBe(ids.length); // unique
  });

  it("pins the package + model URLs", () => {
    expect(KOKORO_ONNX_VERSION).toBe("0.4.9");
    expect(KOKORO_MODEL_URL).toMatch(/kokoro-v1\.0\.int8\.onnx$/);
    expect(KOKORO_VOICES_URL).toMatch(/voices-v1\.0\.bin$/);
  });

  it("resolveVoice falls back to the default and validates", () => {
    expect(resolveVoice(undefined)).toBe("af_heart");
    expect(resolveVoice("am_adam")).toBe("am_adam");
    expect(() => resolveVoice("nope")).toThrow(/unknown voice/i);
  });

  it("voiceLang maps prefix → espeak lang", () => {
    expect(voiceLang("af_heart")).toBe("en-us");
    expect(voiceLang("am_adam")).toBe("en-us");
    expect(voiceLang("bf_emma")).toBe("en-gb");
    expect(voiceLang("bm_george")).toBe("en-gb");
  });

  it("ttsModelsDir is under ~/.libi/models/tts/kokoro", () => {
    expect(ttsModelsDir()).toBe(path.join(tmp, "models", "tts", "kokoro"));
  });

  it("isKokoroModelInstalled only when both files exist", () => {
    const { onnxPath, voicesPath } = kokoroModelPaths();
    expect(isKokoroModelInstalled()).toBe(false);
    fs.mkdirSync(path.dirname(onnxPath), { recursive: true });
    fs.writeFileSync(onnxPath, "x");
    expect(isKokoroModelInstalled()).toBe(false); // voices missing
    fs.writeFileSync(voicesPath, "y");
    expect(isKokoroModelInstalled()).toBe(true);
  });

  it("listVoiceStatus reports modelInstalled + isDefault", () => {
    const s = listVoiceStatus();
    expect(s.modelInstalled).toBe(false);
    expect(s.default).toBe("af_heart");
    expect(s.voices.find((v) => v.id === "af_heart")?.isDefault).toBe(true);
    expect(s.voices.find((v) => v.id === "am_adam")?.isDefault).toBe(false);
  });
});
