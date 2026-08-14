import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tts-dl-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A complete JobContext for the runner (the params schema is empty). */
function makeCtx() {
  return {
    jobId: "job-tts-test",
    params: {},
    resumeState: null,
    reportProgress: vi.fn(),
    checkpoint: async () => {},
    shouldCancel: () => false,
  };
}

/** Lay down what a real download leaves behind, so the runner's
 *  verify-before-success check sees an actually-installed model. */
async function layDownModel() {
  const voices = await import("@/lib/tts/voices");
  const { onnxPath, voicesPath } = voices.kokoroModelPaths();
  fs.mkdirSync(path.dirname(onnxPath), { recursive: true });
  fs.writeFileSync(onnxPath, "x");
  fs.writeFileSync(voicesPath, "y");
}

describe("ttsModelDownloadRunner", () => {
  it("short-circuits when the model is already installed", async () => {
    const voices = await import("@/lib/tts/voices");
    const { onnxPath, voicesPath } = voices.kokoroModelPaths();
    fs.mkdirSync(path.dirname(onnxPath), { recursive: true });
    fs.writeFileSync(onnxPath, "x");
    fs.writeFileSync(voicesPath, "y");
    const { ttsModelDownloadRunner } = await import(
      "@/lib/jobs/runners/tts-model-download"
    );
    const ctx = makeCtx();
    const r = await ttsModelDownloadRunner.run(ctx);
    expect(r.alreadyInstalled).toBe(true);
  });

  it("calls downloadModel when not installed", async () => {
    const synth = await import("@/lib/tts/synthesize");
    const spy = vi
      .spyOn(synth, "downloadModel")
      .mockImplementation(async () => layDownModel());
    const { ttsModelDownloadRunner } = await import(
      "@/lib/jobs/runners/tts-model-download"
    );
    const ctx = makeCtx();
    const r = await ttsModelDownloadRunner.run(ctx);
    expect(spy).toHaveBeenCalledOnce();
    expect(r.alreadyInstalled).toBe(false);
  });

  it("forwards granular download progress (bytes → MB) to reportProgress", async () => {
    const synth = await import("@/lib/tts/synthesize");
    vi.spyOn(synth, "downloadModel").mockImplementation(
      async (onProgress?: (d: number, t: number) => void) => {
        onProgress?.(40_000_000, 110_000_000);
        onProgress?.(110_000_000, 110_000_000);
        await layDownModel();
      },
    );
    const { ttsModelDownloadRunner } = await import(
      "@/lib/jobs/runners/tts-model-download"
    );
    const ctx = makeCtx();
    await ttsModelDownloadRunner.run(ctx);
    expect(ctx.reportProgress).toHaveBeenCalledWith(40, 110, "MB");
    expect(ctx.reportProgress).toHaveBeenCalledWith(110, 110, "MB");
  });

  it("FAILS instead of reporting success when the weights did not land", async () => {
    // A clean exit from the downloader is NOT evidence the ONNX weights and
    // voice pack are on disk. Writing the marker on that assumption is the
    // same lie as music_model_download (#59) — the job reads `completed` and
    // the failure resurfaces later as an opaque synthesis error.
    const synth = await import("@/lib/tts/synthesize");
    vi.spyOn(synth, "downloadModel").mockResolvedValue();
    const voices = await import("@/lib/tts/voices");
    const { ttsModelDownloadRunner } = await import(
      "@/lib/jobs/runners/tts-model-download"
    );
    const ctx = makeCtx();
    await expect(ttsModelDownloadRunner.run(ctx)).rejects.toThrow(
      /NOT installed/,
    );
    expect(
      fs.existsSync(path.join(voices.ttsModelsDir(), ".install-token")),
      "writing the marker here makes every later install probe inherit the lie",
    ).toBe(false);
  });

  it("is registered under kind tts_model_download", async () => {
    const { ttsModelDownloadRunner } = await import(
      "@/lib/jobs/runners/tts-model-download"
    );
    expect(ttsModelDownloadRunner.kind).toBe("tts_model_download");
    expect(ttsModelDownloadRunner.maxConcurrent).toBe(1);
  });
});
