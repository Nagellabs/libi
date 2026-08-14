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

  it("forwards granular per-file download progress to reportProgress", async () => {
    vi.mocked(downloadModel).mockImplementationOnce(
      async (_model: string, onProgress?: (d: number, t: number) => void) => {
        onProgress?.(2, 5);
        onProgress?.(5, 5);
        layDownModel("base");
      },
    );
    const c = ctx({ model: "base" });
    await whisperModelDownloadRunner.run(c as never);
    expect(c.reportProgress).toHaveBeenCalledWith(2, 5, "files");
    expect(c.reportProgress).toHaveBeenCalledWith(5, 5, "files");
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
