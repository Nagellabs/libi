import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitForRenderJobSettlement } from "@/lib/export/drivers/settle-wait";
import {
  createRenderJob,
  resolveRenderJob,
  rejectRenderJob,
  __resetRegistryForTests,
  type RenderPayload,
} from "@/lib/export/render-jobs";
import type { ExportSettings } from "@/lib/engine/types";

describe("waitForRenderJobSettlement", () => {
  beforeEach(() => {
    __resetRegistryForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves within one poll tick after the job settles", async () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    j.done.catch(() => {}); // guard against unhandled rejection paths
    const wait = waitForRenderJobSettlement(j.jobId, { pollMs: 100, capMs: 10_000 });
    resolveRenderJob(j.jobId, j.token, { tempFilePath: "/tmp/x.mp4", durationSeconds: 1 });
    // Job is now settled; the next poll tick resolves the wait.
    vi.advanceTimersByTime(100);
    await expect(wait).resolves.toBeUndefined();
  });

  it("resolves at capMs when the job never settles", async () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    j.done.catch(() => {}); // stall/absolute timers won't fire in this window
    const wait = waitForRenderJobSettlement(j.jobId, { pollMs: 10_000, capMs: 500 });
    vi.advanceTimersByTime(500);
    await expect(wait).resolves.toBeUndefined();
  });

  it("never rejects — a rejected job still resolves the wait", async () => {
    const j = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    j.done.catch(() => {});
    const wait = waitForRenderJobSettlement(j.jobId, { pollMs: 100, capMs: 10_000 });
    rejectRenderJob(j.jobId, j.token, "boom");
    vi.advanceTimersByTime(100);
    await expect(wait).resolves.toBeUndefined();
  });
});
