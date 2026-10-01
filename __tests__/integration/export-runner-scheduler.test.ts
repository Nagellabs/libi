/**
 * The export job and the scheduler: it waits (and says why) while the machine
 * is full, then renders; a failed or cancelled export always gives its slot
 * back; an encoder that refuses a session lowers the cap. Backends are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage } from "@/lib/storage";
import { getLibiStorageDir } from "@/lib/libi-home";
import { getDb } from "@/lib/db/client";
import type { JobContext } from "@/lib/jobs/types";

const stub = vi.hoisted(() => ({
  fail: null as Error | null,
  /** The chromium backend runs until it is aborted — a render in progress. */
  hang: false,
  started: null as null | (() => void),
  /** Pretend the classifier chose ffmpeg-overlay (and the machine has a hardware encoder). */
  ffmpeg: false,
  ffmpegCalls: [] as Array<{ forceSoftwareEncoder?: boolean }>,
}));
vi.mock("@/lib/export/ensure-chromium", async (orig) => ({ ...(await orig<typeof import("@/lib/export/ensure-chromium")>()), ensureChromium: vi.fn(async () => {}) }));
vi.mock("@/lib/export/backends/chromium-render", () => ({
  ChromiumRenderBackend: class {
    async run(ctx: { signal?: AbortSignal }) {
      stub.started?.();
      if (stub.hang) {
        await new Promise<never>((_resolve, reject) => ctx.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      if (stub.fail) throw stub.fail;
      return { blob: new Blob([new Uint8Array([1])]), duration: 1 };
    }
  },
}));
vi.mock("@/lib/export/classifier", async (orig) => {
  const real = await orig<typeof import("@/lib/export/classifier")>();
  return { ...real, classifyExportShape: (c: Parameters<typeof real.classifyExportShape>[0]) => (stub.ffmpeg ? { tag: "ffmpeg-overlay" as const } : real.classifyExportShape(c)) };
});
vi.mock("@/lib/export/backends/ffmpeg-overlay", () => ({
  overlayGraphNeedsBrowser: async () => false,
  FfmpegOverlayBackend: class {
    async run(ctx: { outputPath: string; forceSoftwareEncoder?: boolean }) {
      stub.ffmpegCalls.push({ forceSoftwareEncoder: ctx.forceSoftwareEncoder });
      if (stub.fail) throw stub.fail;
      fs.writeFileSync(ctx.outputPath, new Uint8Array([1, 2]));
      return { blob: new Blob([]), duration: 1 };
    }
  },
}));
vi.mock("@/lib/export/hw-accel", async (orig) => ({
  ...(await orig<typeof import("@/lib/export/hw-accel")>()),
  detectAvailableEncoders: async () => new Set(["h264_videotoolbox"]),
  pickEncoder: () => "h264_videotoolbox",
}));

import { exportRunner, type ExportParams } from "@/lib/jobs/runners/export";
import { ExportScheduler, BACKGROUND_EXAMPLE_ESTIMATE, HW_SESSION_FAILED_MESSAGE } from "@/lib/export/scheduler";
import type { CostEstimate } from "@/lib/export/cost";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { createExportRecord, getExportRecord, getExportView } from "@/lib/exports/store";

const PIECE = "p-runner-scheduler";
const GB = 1024 ** 3;
let ticks: Array<[number, number, string | undefined]> = [];

function ctx(params: ExportParams, shouldCancel: () => boolean = () => false): JobContext<ExportParams> {
  return { jobId: "job-s", params, resumeState: null, reportProgress: (d, t, u) => void ticks.push([d, t, u]), checkpoint: async () => {}, shouldCancel };
}
function params(exportId: string): ExportParams {
  return { pieceId: PIECE, source: "draft", filename: "out", exportId, settings: { format: "mp4", codec: "avc", bitrate: 1, width: 320, height: 240, fps: 24 } } as ExportParams;
}
function record(name = "out") {
  return createExportRecord({ pieceId: PIECE, name, source: "user", settings: { format: "mp4", codec: "avc", fps: 24, width: 320, height: 240 } });
}
/** 4 cores → cap 1: one export at a time, deterministic whatever machine runs the test. */
function installScheduler(config: { hwSessionCap: number; softwareFallbackSafe: boolean } = { hwSessionCap: 1, softwareFallbackSafe: false }, cores = 4): ExportScheduler {
  const s = new ExportScheduler({ snapshot: () => ({ cores, totalMemBytes: 16 * GB, availMemBytes: 12 * GB, load1: 0 }), config, reevaluateMs: 20 });
  globalThis.__libiExportScheduler = s;
  return s;
}

beforeEach(async () => {
  stub.fail = null;
  stub.hang = false;
  stub.started = null;
  stub.ffmpeg = false;
  stub.ffmpegCalls = [];
  ticks = [];
  createTestDb();
  createTempStorageDir();
  resetStorage();
  seedPiece(getDb() as never, { id: PIECE });
  const m = await loadManifest(PIECE);
  Object.assign(m, { width: 320, height: 240, fps: 24 });
  m.overlays = [{ id: "c", kind: "code", startTime: 0, duration: 1, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 320, height: 240 }, drawFunction: "// d" }] as typeof m.overlays;
  await saveManifest(PIECE, m);
});
afterEach(() => {
  globalThis.__libiExportScheduler = undefined;
  cleanupTempDir();
  resetTestDb();
  resetStorage();
});

const exportsDir = () => path.join(getLibiStorageDir(), PIECE, "exports");
const filesInExports = () => (fs.existsSync(exportsDir()) ? fs.readdirSync(exportsDir()) : []);
const HW_ESTIMATE: CostEstimate = { backend: "ffmpeg-overlay", memoryBytes: 500 * 1024 ** 2, cpu: 1, hwEncoder: true, softwareFallback: true, renderWorkers: 0 };

describe("export runner ↔ scheduler", () => {
  it("waits while the machine is full — queued, with the reason on its record — then renders", async () => {
    const s = installScheduler();
    const other = await s.acquire({ id: "other", priority: "foreground", estimate: BACKGROUND_EXAMPLE_ESTIMATE });
    const rec = record();
    const run = exportRunner.run(ctx(params(rec.id)));
    await new Promise((r) => setTimeout(r, 60));
    expect(ticks).toContainEqual([0, 1, "waiting"]);
    expect(getExportRecord(rec.id)?.status).toBe("queued");
    expect((await getExportView(rec.id))?.waiting).toEqual({ reason: "cap", message: "Waiting for a free export slot — 1 export running" });
    other.release();
    await run;
    expect(getExportRecord(rec.id)?.status).toBe("done");
    expect(s.runningCount()).toBe(0);
  });

  it("a failed render gives its slot back", async () => {
    const s = installScheduler();
    stub.fail = new Error("render exploded");
    await expect(exportRunner.run(ctx(params(record().id)))).rejects.toThrow("render exploded");
    expect(s.runningCount()).toBe(0);
  });

  it("a cancel while waiting leaves the queue and gives nothing back twice", async () => {
    const s = installScheduler();
    const other = await s.acquire({ id: "other", priority: "foreground", estimate: BACKGROUND_EXAMPLE_ESTIMATE });
    let cancelled = false;
    const rec = record();
    const run = exportRunner.run(ctx(params(rec.id), () => cancelled));
    await new Promise((r) => setTimeout(r, 40));
    cancelled = true;
    await expect(run).rejects.toThrow();
    expect(getExportRecord(rec.id)?.status).toBe("cancelled");
    expect(s.runningCount()).toBe(1);
    other.release();
    expect(s.runningCount()).toBe(0);
    // It never reached the claim: no placeholder, no folder content at all.
    expect(filesInExports()).toEqual([]);
  });

  it("a render cancelled mid-way gives its slot back and leaves no partial file", async () => {
    const s = installScheduler();
    stub.hang = true;
    const running = new Promise<void>((r) => (stub.started = r));
    let cancelled = false;
    const rec = record();
    const run = exportRunner.run(ctx(params(rec.id), () => cancelled));
    const outcome = run.then(() => "done", (e: Error) => e.message);
    await running;
    expect(s.runningCount()).toBe(1);
    expect(getExportRecord(rec.id)?.status).toBe("running");
    cancelled = true;
    await outcome;
    expect(getExportRecord(rec.id)?.status).toBe("cancelled");
    expect(s.runningCount()).toBe(0);
    expect(filesInExports()).toEqual([]);
  });

  it("two exports on a machine with room render at the same time", async () => {
    const s = installScheduler(undefined, 8); // 8 cores → two at once
    stub.hang = true;
    let started = 0;
    stub.started = () => void started++;
    const cancelledAll = { v: false };
    const runs = [record("one"), record("two")].map((rec) => exportRunner.run(ctx(params(rec.id), () => cancelledAll.v)).catch(() => undefined));
    await new Promise((r) => setTimeout(r, 100));
    expect(started).toBe(2);
    expect(s.runningCount()).toBe(2);
    cancelledAll.v = true;
    await Promise.all(runs);
    expect(s.runningCount()).toBe(0);
  });

  it("a hardware encoder that refuses a session fails the export in plain words, lowers the cap, and gives the slot back", async () => {
    const s = installScheduler({ hwSessionCap: 2, softwareFallbackSafe: false }, 8);
    stub.ffmpeg = true;
    stub.fail = new Error("ffmpeg exited with code 187: [h264_videotoolbox] Error: cannot create compression session: -12903");
    const rec = record();
    await expect(exportRunner.run(ctx(params(rec.id)))).rejects.toThrow(HW_SESSION_FAILED_MESSAGE);
    expect(getExportRecord(rec.id)).toMatchObject({ status: "failed", error: HW_SESSION_FAILED_MESSAGE });
    expect(s.runningCount()).toBe(0);
    // The cap was 2 hardware sessions; it is 1 now: a second hardware export waits for the encoder.
    const first = await s.acquire({ id: "hw1", priority: "foreground", estimate: HW_ESTIMATE });
    const second = s.acquire({ id: "hw2", priority: "foreground", estimate: HW_ESTIMATE });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.waitingInfo("hw2")?.reason).toBe("encoder");
    first.release();
    (await second).release();
  });

  it("ffmpeg's generic encoder-open failure (a bad parameter) is NOT a session refusal: the cap stays and the message stays", async () => {
    const s = installScheduler({ hwSessionCap: 2, softwareFallbackSafe: false }, 8);
    stub.ffmpeg = true;
    stub.fail = new Error("ffmpeg exited with code 187: Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate");
    const rec = record();
    await expect(exportRunner.run(ctx(params(rec.id)))).rejects.toThrow("Error while opening encoder");
    expect(s.runningCount()).toBe(0);
    const first = await s.acquire({ id: "hw1", priority: "foreground", estimate: HW_ESTIMATE });
    const second = await s.acquire({ id: "hw2", priority: "foreground", estimate: HW_ESTIMATE });
    expect(s.runningCount()).toBe(2);
    first.release();
    second.release();
  });

  it("every hardware session taken and the fallback safe: it runs as libx264 beside them instead of waiting", async () => {
    const s = installScheduler({ hwSessionCap: 1, softwareFallbackSafe: true }, 8);
    stub.ffmpeg = true;
    const holder = await s.acquire({ id: "hw-holder", priority: "foreground", estimate: HW_ESTIMATE });
    const rec = record();
    await exportRunner.run(ctx(params(rec.id)));
    expect(stub.ffmpegCalls).toEqual([{ forceSoftwareEncoder: true }]);
    expect(getExportRecord(rec.id)?.status).toBe("done");
    holder.release();
    expect(s.runningCount()).toBe(0);
  });

  it("with a hardware session free it asks for no software encoder", async () => {
    installScheduler({ hwSessionCap: 2, softwareFallbackSafe: true }, 8);
    stub.ffmpeg = true;
    await exportRunner.run(ctx(params(record().id)));
    expect(stub.ffmpegCalls).toEqual([{ forceSoftwareEncoder: false }]);
  });
});
