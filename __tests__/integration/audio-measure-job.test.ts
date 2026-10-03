/**
 * The `audio_measure` job on the REAL JobManager (real ffmpeg): it runs, returns the levels, and a repeat
 * of the same question is answered from the job table (`matching_completed`, no second render) because the
 * params carry the hash of the audio; an edited clip is a different job; a piece that changed since the
 * call was made is refused rather than answered for the wrong audio.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { hasFfmpeg } from "@/__tests__/helpers/media";

const mockStore = vi.hoisted(() => ({ root: "" }));
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(path.join(mockStore.root, "storage"));
  },
}));

import { getDb } from "@/lib/db/client";
import { files, jobs } from "@/lib/db/schema/sqlite";
import { getJobManager } from "@/lib/jobs/manager";
import { __resetRunnerRegistryForTests, getRunner, registerBuiltinRunners } from "@/lib/jobs/runners/registry";
import { audioMeasureRunner } from "@/lib/jobs/runners/audio-measure";
import { audioMixHash, type MeasureResult } from "@/lib/export/audio-measure";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import type { AudioClip } from "@/lib/engine/types";
import type { JobContext } from "@/lib/jobs/types";

const PIECE = "p-job";
const describeIf = hasFfmpeg() ? describe : describe.skip;
let home = "";

const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: "bed", kind: "standalone", fileId: "f-bed", startTime: 0, duration: 10, trimStart: 0, volume: 1, enabled: true, ...over,
});

async function setClips(audioClips: AudioClip[]) {
  const m = await loadManifest(PIECE);
  await saveManifest(PIECE, { ...m, audioClips });
}
async function paramsFor(over: { ranges?: Array<{ from: number; to: number }> } = {}) {
  const m = await loadManifest(PIECE);
  const rows = getDb().select().from(files).all();
  return { pieceId: PIECE, ranges: over.ranges ?? [{ from: 2, to: 6 }], per: "mix" as const, mixHash: audioMixHash(m, rows) };
}
/** What `POST /api/jobs` does after an enqueue: drive a new job to its end, then read its row. */
async function finished(jobId: string): Promise<{ status: string; result: MeasureResult | null; error: string | null }> {
  await getJobManager().runToCompletion(jobId).catch(() => undefined);
  const row = getDb().select().from(jobs).all().find((j) => j.id === jobId)!;
  return { status: row.status, result: row.resultJson ? (JSON.parse(row.resultJson) as MeasureResult) : null, error: row.error ?? null };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-measure-job-"));
  process.env.LIBI_HOME = home;
  mockStore.root = home;
  delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  const db = createTestDb();
  seedPiece(db, { id: PIECE });
  __resetRunnerRegistryForTests();
  registerBuiltinRunners();
  const dir = path.join(home, "storage", PIECE);
  fs.mkdirSync(dir, { recursive: true });
  if (hasFfmpeg()) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*1000*t):s=44100:d=10:c=mono", path.join(dir, "bed.wav")]);
  }
  db.insert(files).values({ id: "f-bed", pieceId: PIECE, filename: "bed.wav", name: "bed.wav", description: "", type: "audio", storagePath: `${PIECE}/bed.wav`, size: 100, mediaDuration: 10, hasAudio: true } as never).run();
  fs.writeFileSync(path.join(dir, "composition.json"), JSON.stringify({ width: 1080, height: 1920, fps: 30, overlays: [], audioClips: [clip()] }));
});
afterEach(() => {
  delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  resetTestDb();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("registration", () => {
  it("is a registered kind that routes chat progress to libi.audio_analyze and is not paid", () => {
    expect(getRunner("audio_measure")).toBe(audioMeasureRunner);
    expect(audioMeasureRunner.mcpToolId).toBe("libi:libi.audio_analyze");
    expect(audioMeasureRunner.paid).toBeUndefined();
    expect(() => audioMeasureRunner.paramsSchema.parse({ pieceId: "p", ranges: [], per: "mix", mixHash: "x" })).toThrow();
    expect(() => audioMeasureRunner.paramsSchema.parse({ pieceId: "p", ranges: [{ from: 0, to: 1 }], per: "mix" })).toThrow(); // no mixHash: no cache key
  });
});

describeIf("the job (real JobManager, real ffmpeg)", () => {
  it("runs: levels in the result row; an identical question is a cache hit and renders nothing", async () => {
    const jm = getJobManager();
        const params = await paramsFor();
        const first = await jm.enqueue("audio_measure", params, { pieceId: PIECE });
    expect(first.status).toBe("new");
    const done = await finished((first as { jobId: string }).jobId);
    expect(done.status).toBe("completed");
    expect(done.result!.ranges[0].rmsDb).toBeCloseTo(-23, 0);
    expect(done.result!.ranges[0].peakDb).toBeCloseTo(-20, 0);

    const runSpy = vi.spyOn(audioMeasureRunner, "run");
    const again = await jm.enqueue("audio_measure", await paramsFor(), { pieceId: PIECE });
    expect(again.status).toBe("matching_completed");
    expect(runSpy).not.toHaveBeenCalled();
    expect((again as { existingJob: { result: MeasureResult } }).existingJob.result.ranges[0].rmsDb).toBeCloseTo(-23, 0);
    runSpy.mockRestore();
  });

  it("different ranges, or an edited clip, are different jobs with their own answers", async () => {
    const jm = getJobManager();
    const a = (await jm.enqueue("audio_measure", await paramsFor(), { pieceId: PIECE })) as { jobId: string };
    await finished(a.jobId);
    const other = await jm.enqueue("audio_measure", await paramsFor({ ranges: [{ from: 1, to: 3 }] }), { pieceId: PIECE });
    expect(other.status).toBe("new");
    await finished((other as { jobId: string }).jobId);

    await setClips([clip({ gainDb: 6.0206 })]);
    const boosted = await jm.enqueue("audio_measure", await paramsFor(), { pieceId: PIECE });
    expect(boosted.status).toBe("new");
    const done = await finished((boosted as { jobId: string }).jobId);
    expect(done.result!.ranges[0].peakDb).toBeCloseTo(-14, 0);
  });

  it("refuses to answer for audio that changed after the call was made", async () => {
    const stale = await paramsFor();
    await setClips([clip({ gainDb: 3 })]);
    const jm = getJobManager();
    const job = (await jm.enqueue("audio_measure", stale, { pieceId: PIECE })) as { jobId: string };
    const done = await finished(job.jobId);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/changed while this measure was queued/);
  });

  it("a cancel stops the render (the abort reaches ffmpeg) and ends as cancelled", async () => {
    const params = audioMeasureRunner.paramsSchema.parse(await paramsFor());
    let cancelled = false;
    const ctx = {
      jobId: "j-cancel", params, resumeState: null,
      reportProgress: () => { cancelled = true; },
      checkpoint: async () => undefined,
      shouldCancel: () => cancelled,
    } as unknown as JobContext<typeof params>;
    await expect(audioMeasureRunner.run(ctx)).rejects.toMatchObject({ name: "CancelledError" });
  });
});
