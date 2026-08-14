import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createRenderJob,
  getRenderJob,
  getRenderJobTokenByJobId,
  resolveRenderJob,
  rejectRenderJob,
  recordRenderProgress,
  __resetRegistryForTests,
  RENDER_STALL_TIMEOUT_MS,
  type RenderPayload,
} from "@/lib/export/render-jobs";
import type { ExportSettings } from "@/lib/engine/types";

describe("render-jobs registry", () => {
  beforeEach(() => {
    __resetRegistryForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a job with a unique id + one-time token", () => {
    const a = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    const b = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.token).not.toBe(b.token);
  });

  it("getRenderJob returns the entry for valid id + token", () => {
    const j = createRenderJob({ pieceId: "p1", payload: { id: "c1" } as unknown as RenderPayload, settings: { format: "mp4" } as unknown as ExportSettings });
    const got = getRenderJob(j.jobId, j.token);
    expect(got?.payload).toEqual({ id: "c1" });
  });

  it("getRenderJob returns null for wrong token", () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    expect(getRenderJob(j.jobId, "wrong")).toBeNull();
  });

  it("resolveRenderJob settles the promise", async () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    resolveRenderJob(j.jobId, j.token, { tempFilePath: "/tmp/x.mp4", durationSeconds: 1.5 });
    await expect(j.done).resolves.toEqual({ tempFilePath: "/tmp/x.mp4", durationSeconds: 1.5 });
  });

  it("rejectRenderJob rejects the promise", async () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    rejectRenderJob(j.jobId, j.token, "boom");
    await expect(j.done).rejects.toThrow("boom");
  });

  it("rejects at the absolute cap when it never settles (timeoutMs overrides the cap)", async () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings, timeoutMs: 1_000 });
    vi.advanceTimersByTime(1_001);
    await expect(j.done).rejects.toThrow(/absolute cap/i);
  });

  it("rejects after the stall timeout with the no-progress message when no progress is reported", async () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    vi.advanceTimersByTime(RENDER_STALL_TIMEOUT_MS + 1);
    await expect(j.done).rejects.toThrow(/stalled — no progress reported/);
  });

  it("keeps a job alive across many stall windows while progress keeps ticking", async () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    // A tick every 60s stays well inside the 120s stall window. Run 10+ minutes.
    for (let i = 1; i <= 11; i++) {
      recordRenderProgress(j.jobId, j.token, i * 30, 5183);
      vi.advanceTimersByTime(60_000);
    }
    // Still alive — settling succeeds rather than the stall timer having fired.
    expect(resolveRenderJob(j.jobId, j.token, { tempFilePath: "/tmp/x.mp4", durationSeconds: 660 })).toBe(true);
    await expect(j.done).resolves.toEqual({ tempFilePath: "/tmp/x.mp4", durationSeconds: 660 });
  });

  it("rejects with the frame-count message after silence following the last progress tick", async () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    recordRenderProgress(j.jobId, j.token, 3029, 5183);
    vi.advanceTimersByTime(RENDER_STALL_TIMEOUT_MS + 1);
    await expect(j.done).rejects.toThrow(/stalled — no progress for \d+s \(frame 3029\/5183\)/);
  });

  it("honors a stallTimeoutMs override", async () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings, stallTimeoutMs: 500 });
    vi.advanceTimersByTime(499);
    // Not yet — still under the override window.
    recordRenderProgress(j.jobId, j.token, 1, 10);
    vi.advanceTimersByTime(499);
    // Reset by the tick above; still alive.
    expect(getRenderJob(j.jobId, j.token)).not.toBeNull();
    vi.advanceTimersByTime(2);
    await expect(j.done).rejects.toThrow(/stalled/);
  });

  it("resolveRenderJob clears both timers — no double-settle after runAllTimers", async () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    expect(resolveRenderJob(j.jobId, j.token, { tempFilePath: "/tmp/x.mp4", durationSeconds: 1 })).toBe(true);
    vi.runAllTimers();
    await expect(j.done).resolves.toEqual({ tempFilePath: "/tmp/x.mp4", durationSeconds: 1 });
  });

  it("rejectRenderJob clears both timers — no double-settle after runAllTimers", async () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    expect(rejectRenderJob(j.jobId, j.token, "boom")).toBe(true);
    vi.runAllTimers();
    await expect(j.done).rejects.toThrow("boom");
  });

  it("getRenderJob returns null after settle (one-time use)", () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    resolveRenderJob(j.jobId, j.token, { tempFilePath: "/tmp/x.mp4", durationSeconds: 1 });
    expect(getRenderJob(j.jobId, j.token)).toBeNull();
  });

  it("getRenderJobTokenByJobId returns null for unknown jobId", () => {
    expect(getRenderJobTokenByJobId("does-not-exist")).toBeNull();
  });

  it("getRenderJobTokenByJobId returns null for settled jobs", () => {
    const job = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    resolveRenderJob(job.jobId, job.token, { tempFilePath: "/tmp/x.mp4", durationSeconds: 1 });
    expect(getRenderJobTokenByJobId(job.jobId)).toBeNull();
  });
});
