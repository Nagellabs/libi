import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { FileRecord } from "@/lib/db/schema/types";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tts-gs-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ttsListVoices", () => {
  it("returns default + voices + modelInstalled", async () => {
    const { ttsListVoices } = await import("@/mcp/tools/tts-tools");
    const r = await ttsListVoices({});
    expect(r.success).toBe(true);
    const data = r.data as { default: string; modelInstalled: boolean; voices: unknown };
    expect(data.default).toBe("af_heart");
    expect(data.modelInstalled).toBe(false);
    expect(Array.isArray(data.voices)).toBe(true);
  });
});

describe("generateSpeech", () => {
  it("returns needs_install when the model is absent (no synth)", async () => {
    const synth = await import("@/lib/tts/synthesize");
    const spy = vi.spyOn(synth, "synthesizeSpeech");
    const { generateSpeech } = await import("@/mcp/tools/tts-tools");
    const r = await generateSpeech({ text: "hi" });
    expect(r.success).toBe(false);
    const data = r.data as { status: string; hint: string };
    expect(data.status).toBe("needs_install");
    expect(data.hint).toMatch(/get_install_plan/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("synthesizes via injected synthFn and stores the file", async () => {
    const fileTools = await import("@/mcp/tools/file-tools");
    const fakeRecord = { id: "f1", filename: "speech.wav" };
    const storeSpy = vi
      .spyOn(fileTools, "storeFile")
      .mockResolvedValue(fakeRecord as FileRecord);
    const wav = path.join(tmp, "out.wav");
    fs.writeFileSync(wav, Buffer.from("RIFFWAVE"));
    const { generateSpeech } = await import("@/mcp/tools/tts-tools");
    const r = await generateSpeech(
      { text: "Welcome to Libi", voice: "am_adam", withTimestamps: true, pieceId: "p1" },
      undefined,
      async () => ({
        wavPath: wav,
        voice: "am_adam",
        sampleRate: 24000,
        durationSeconds: 1.6,
        words: [{ text: "Welcome", start: 0, end: 0.8 }],
        approximate: true,
      }),
    );
    expect(r.success).toBe(true);
    const data = r.data as { file: FileRecord; voice: string; words: unknown[] };
    expect(data.file).toEqual(fakeRecord);
    expect(data.voice).toBe("am_adam");
    expect(data.words).toHaveLength(1);
    expect(storeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pieceId: "p1", contentType: "audio/wav", hasAudio: true }),
    );
    expect(fs.existsSync(wav)).toBe(false); // temp cleaned up
  });
});
