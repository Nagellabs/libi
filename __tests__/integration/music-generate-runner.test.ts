import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-music-gen-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("musicGenerateRunner", () => {
  it("calls generateMusic with progress + cancel bridges and returns the result", async () => {
    const gen = await import("@/lib/music/generate");
    const wav = path.join(tmp, "o.wav");
    fs.writeFileSync(wav, Buffer.from("RIFFWAVE"));
    const spy = vi
      .spyOn(gen, "generateMusic")
      .mockImplementation(async (_o, onProgress) => {
        onProgress?.(2, 2);
        return {
          wavPath: wav,
          sampleRate: 48000,
          durationSeconds: 8,
          channels: 2,
          instrumental: true,
          seed: 1,
        };
      });
    const { musicGenerateRunner } = await import(
      "@/lib/jobs/runners/music-generate"
    );
    const report = vi.fn();
    const ctx = {
      jobId: "job-music-test",
      params: { prompt: "calm lofi", durationSeconds: 8, instrumental: true },
      resumeState: null,
      reportProgress: report,
      checkpoint: async () => {},
      shouldCancel: () => false,
    };
    const r = await musicGenerateRunner.run(ctx);
    expect(spy).toHaveBeenCalledOnce();
    expect(r.wavPath).toBe(wav);
    expect(r.sampleRate).toBe(48000);
    expect(report).toHaveBeenCalledWith(2, 2, "sec");
  });

  it("is registered under kind music_generate, maxConcurrent 1", async () => {
    const { musicGenerateRunner } = await import(
      "@/lib/jobs/runners/music-generate"
    );
    expect(musicGenerateRunner.kind).toBe("music_generate");
    expect(musicGenerateRunner.maxConcurrent).toBe(1);
    expect(
      musicGenerateRunner.paramsSchema.safeParse({
        prompt: "x",
        durationSeconds: 8,
      }).success,
    ).toBe(true);
  });
});
