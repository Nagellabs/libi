import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("@/lib/whisper/transcribe", () => ({
  downloadModel: vi.fn(async () => {}),
}));

import { downloadModel } from "@/lib/whisper/transcribe";
import { whisperModelDownloadRunner } from "@/lib/jobs/runners/whisper-model-download";
import { hfCacheDirName, whisperModelsDir } from "@/lib/whisper/models";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-wdl-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** Lay down what a real download leaves behind, so the runner's
 *  verify-before-success check sees an actually-installed model. */
function layDownModel(model: string) {
  const snap = path.join(whisperModelsDir(), hfCacheDirName(model), "snapshots", "r1");
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(snap, "model.bin"), "x");
}

function ctx(params: { model: string }) {
  return {
    jobId: "j1",
    params,
    resumeState: null,
    reportProgress: vi.fn(),
    checkpoint: vi.fn(async () => {}),
    shouldCancel: () => false,
  };
}

describe("whisperModelDownloadRunner", () => {
  it("kind + maxConcurrent", () => {
    expect(whisperModelDownloadRunner.kind).toBe("whisper_model_download");
    expect(whisperModelDownloadRunner.maxConcurrent).toBe(1);
  });

  it("skips download when model already present", async () => {
    const snap = path.join(
      whisperModelsDir(),
      hfCacheDirName("small"),
      "snapshots",
      "r1",
    );
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, "model.bin"), "x");
    const res = await whisperModelDownloadRunner.run(
      ctx({ model: "small" }) as never,
    );
    expect(res.alreadyInstalled).toBe(true);
    expect(downloadModel).not.toHaveBeenCalled();
  });

  it("calls downloadModel when absent", async () => {
    vi.mocked(downloadModel).mockImplementationOnce(async () => layDownModel("base"));
    const res = await whisperModelDownloadRunner.run(
      ctx({ model: "base" }) as never,
    );
    expect(downloadModel).toHaveBeenCalledWith("base", expect.any(Function));
    expect(res.model).toBe("base");
    expect(res.alreadyInstalled).toBe(false);
  });

  // This test used to assert `(2, 5, "files")` — the per-file counter. That
  // contract was REMOVED on purpose, not weakened: faster-whisper ticks once per
  // completed file, and the repo is a few tiny configs plus one large weights
  // file, so the counter reported 0/1 for a whole ~5 minute download (measured
  // on published 0.1.2). Progress is now measured in bytes on disk and reported
  // in MB, matching tts_model_download and music_model_download. Units are NOT
  // mixed within one job because the rolling ETA averages ms-per-unit.
  //
  // The file callback still exists and is still passed — its job is now to POKE
  // a re-measure, since a completed file is exactly when on-disk bytes jump.
  it("reports download progress in MB, and never in file counts", async () => {
    vi.mocked(downloadModel).mockImplementationOnce(
      async (_model: string, onProgress?: (d: number, t: number) => void) => {
        onProgress?.(2, 5);
        onProgress?.(5, 5);
        layDownModel("base");
      },
    );
    const c = ctx({ model: "base" });
    await whisperModelDownloadRunner.run(c as never);

    const calls = vi.mocked(c.reportProgress).mock.calls as Array<
      [number, number, string]
    >;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some(([, , unit]) => unit === "files")).toBe(false);
    expect(calls.every(([, , unit]) => unit === "MB")).toBe(true);

    // "base" is ~145 MB in the catalogue, and the job must end pinned at 100%.
    expect(c.reportProgress).toHaveBeenCalledWith(145, 145, "MB");

    // The poke callback is still handed to the downloader.
    expect(downloadModel).toHaveBeenCalledWith("base", expect.any(Function));
  });

  it("FAILS instead of reporting success when no model files landed", async () => {
    // The default mock resolves without writing anything — a clean exit from
    // the downloader is NOT evidence the snapshot is on disk. Reporting
    // `completed` here is the same lie as music_model_download (#59), and it
    // resurfaces much later as an opaque transcription failure.
    await expect(
      whisperModelDownloadRunner.run(ctx({ model: "base" }) as never),
    ).rejects.toThrow(/NOT installed/);
    // …and the marker must not be written, or every later probe inherits the lie.
    expect(
      fs.existsSync(path.join(whisperModelsDir(), ".install-token")),
    ).toBe(false);
  });
});
