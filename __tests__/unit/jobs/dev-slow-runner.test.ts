import { describe, it, expect, vi } from "vitest";
import { devSlowRunner } from "@/lib/jobs/runners/dev-slow";
import type { JobContext } from "@/lib/jobs/types";

function ctx(over: Partial<JobContext<{ seconds: number; label?: string }>> = {}) {
  return {
    jobId: "j1",
    params: { seconds: 3 },
    resumeState: null,
    reportProgress: vi.fn(),
    checkpoint: vi.fn(async () => {}),
    shouldCancel: () => false,
    ...over,
  } as JobContext<{ seconds: number; label?: string }>;
}

describe("dev_slow runner", () => {
  it("ticks once per second and resolves with the tick count", async () => {
    vi.useFakeTimers();
    const c = ctx();
    const p = devSlowRunner.run(c);
    await vi.advanceTimersByTimeAsync(3100);
    const result = (await p) as { ticks: number };
    expect(result.ticks).toBe(3);
    expect(c.reportProgress).toHaveBeenCalledWith(1, 3, "ticks");
    expect(c.reportProgress).toHaveBeenCalledWith(3, 3, "ticks");
    vi.useRealTimers();
  });

  it("declares the chat-surface identity", () => {
    expect(devSlowRunner.kind).toBe("dev_slow");
    expect(devSlowRunner.mcpToolId).toBe("libi:libi.dev_slow_job");
  });

  it("honors cancellation between ticks", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const c = ctx({ shouldCancel: () => cancelled });
    const p = devSlowRunner.run(c).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1100);
    cancelled = true;
    await vi.advanceTimersByTimeAsync(1100);
    const err = (await p) as Error;
    expect(String(err.message ?? err)).toMatch(/cancel/i);
    vi.useRealTimers();
  });
});
