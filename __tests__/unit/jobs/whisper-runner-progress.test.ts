/**
 * The runner itself must be WIRED to byte progress — not merely have a byte
 * tracker available in the codebase.
 *
 * This is the test that would have caught the 0.1.2 defect. `trackDirectoryBytes`
 * shipped in 0.1.2 and was correct; it was just never called from this runner,
 * so the bar sat at `0/1 files` for the whole ~5 minute download. A test of the
 * tracker alone stays green through exactly that bug, which is why this one
 * drives `whisperModelDownloadRunner.run()` end to end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let modelsDir: string;
let markerRoot: string;
let installed = false;

const downloadModel = vi.fn();

vi.mock("@/lib/whisper/transcribe", () => ({
  downloadModel: (model: string, cb: (d: number, t: number) => void) =>
    downloadModel(model, cb),
}));

vi.mock("@/lib/whisper/models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whisper/models")>();
  return {
    ...actual,
    whisperModelsDir: () => modelsDir,
    isWhisperModelInstalled: () => installed,
  };
});

vi.mock("@/lib/libi-home", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/libi-home")>();
  return { ...actual, getLibiModelsDir: () => markerRoot };
});

interface Reported { done: number; total: number; unit: string }

function makeCtx(reported: Reported[]) {
  return {
    params: { model: "small" as const },
    reportProgress: (done: number, total: number, unit: string) =>
      reported.push({ done, total, unit }),
    shouldCancel: () => false,
    checkpoint: vi.fn(),
    forced: false,
  };
}

describe("whisperModelDownloadRunner progress wiring", () => {
  beforeEach(() => {
    modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-whisper-run-"));
    markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "libi-whisper-mark-"));
    installed = false;
    downloadModel.mockReset();
  });
  afterEach(() => {
    fs.rmSync(modelsDir, { recursive: true, force: true });
    fs.rmSync(markerRoot, { recursive: true, force: true });
  });

  it("reports MB — never a bare file counter — and moves while bytes land", async () => {
    const { whisperModelDownloadRunner } = await import(
      "@/lib/jobs/runners/whisper-model-download"
    );
    const reported: Reported[] = [];

    // Stand in for faster-whisper: write bytes, then tick the file callback.
    downloadModel.mockImplementation(async (_m: string, cb: () => void) => {
      const f = path.join(modelsDir, "model.bin");
      for (const mb of [50, 200, 460]) {
        fs.writeFileSync(f, Buffer.alloc(mb * 1_000_000));
        cb();
        await vi.waitFor(
          () => expect(reported.some((r) => r.done >= mb - 1 && r.unit === "MB")).toBe(true),
          { timeout: 3000 },
        );
      }
      installed = true;
    });

    const result = await whisperModelDownloadRunner.run(
      makeCtx(reported) as never,
    );

    expect(result).toEqual({ model: "small", alreadyInstalled: false });
    // The regression itself: the unit must never be "files".
    expect(reported.some((r) => r.unit === "files")).toBe(false);
    expect(reported.every((r) => r.unit === "MB")).toBe(true);

    // And there must be something BETWEEN the start and the finish — the whole
    // complaint was a bar that only ever showed 0 and then done.
    const mid = reported.filter((r) => r.done > 0 && r.done < r.total);
    expect(mid.length, "no intermediate progress was reported").toBeGreaterThan(0);

    // Ends pinned at 100%.
    expect(reported.at(-1)!.done).toBe(reported.at(-1)!.total);
  });

  it("short-circuits an already-installed model without a download", async () => {
    const { whisperModelDownloadRunner } = await import(
      "@/lib/jobs/runners/whisper-model-download"
    );
    installed = true;
    const reported: Reported[] = [];
    const result = await whisperModelDownloadRunner.run(makeCtx(reported) as never);
    expect(result).toEqual({ model: "small", alreadyInstalled: true });
    expect(downloadModel).not.toHaveBeenCalled();
  });

  it("still fails loudly when the download leaves no model behind", async () => {
    // The pre-existing verify-before-success guard must survive the rewiring.
    const { whisperModelDownloadRunner } = await import(
      "@/lib/jobs/runners/whisper-model-download"
    );
    downloadModel.mockImplementation(async () => {
      /* exits 0, writes nothing */
    });
    await expect(
      whisperModelDownloadRunner.run(makeCtx([]) as never),
    ).rejects.toThrow(/no model files are present/);
  });
});
