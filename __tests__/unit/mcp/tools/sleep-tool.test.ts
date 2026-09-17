import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/mcp/notify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/mcp/notify")>();
  return { ...mod, notify: { ...mod.notify, toolProgress: vi.fn() } };
});
import { notify } from "@/mcp/notify";
import { runWithToolCallContext } from "@/mcp/tool-call-context";
import { sleep } from "@/mcp/tools/sleep-tool";

const PROGRESS_TOKEN = "test-token-1";

describe("libi.sleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(notify.toolProgress).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns success after the requested duration", async () => {
    const promise = sleep({ seconds: 3 }, {});
    // 3s < TICK_MS (5s), so a single chunk of 3000ms
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      cancelled: false,
    });
    expect((result.data as { slept: number }).slept).toBeGreaterThanOrEqual(2.9);
  });

  it("emits progress notifications every 5 seconds", async () => {
    const sendNotification = vi.fn(() => Promise.resolve());
    const promise = sleep(
      { seconds: 12 },
      { sendNotification, _meta: { progressToken: PROGRESS_TOKEN } },
    );

    // Advance through the first 5s chunk
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    // Advance through second 5s chunk (10s total)
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendNotification).toHaveBeenCalledTimes(2);

    // Advance through final 2s chunk (12s total)
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendNotification).toHaveBeenCalledTimes(3);

    const result = await promise;
    expect(result.success).toBe(true);

    // Verify the first call's payload shape
    const firstCallArgs = sendNotification.mock.calls[0][0];
    expect(firstCallArgs.method).toBe("notifications/progress");
    expect(firstCallArgs.params).toHaveProperty("progress");
    expect(firstCallArgs.params).toHaveProperty("total", 12_000);
    expect(firstCallArgs.params).toHaveProperty("progressToken", PROGRESS_TOKEN);
  });

  it("respects the AbortSignal and returns partial", async () => {
    const controller = new AbortController();
    const promise = sleep({ seconds: 30 }, { signal: controller.signal });

    // Sleep for 10 s then abort
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort();
    // Advance a tiny bit so the next chunk-loop iteration sees the aborted flag
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result.success).toBe(true);
    expect((result.data as { cancelled: boolean }).cancelled).toBe(true);
    const slept = (result.data as { slept: number }).slept;
    expect(slept).toBeGreaterThanOrEqual(9.5);
    expect(slept).toBeLessThan(15);
  });

  it("includes reason in notifications when provided", async () => {
    const sendNotification = vi.fn(() => Promise.resolve());
    const promise = sleep(
      { seconds: 6, reason: "waiting for fal job to finish" },
      { sendNotification, _meta: { progressToken: PROGRESS_TOKEN } },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendNotification).toHaveBeenCalled();
    const args = sendNotification.mock.calls[0][0];
    expect(args.params.message).toMatch(/waiting for fal job to finish/);
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;
  });

  it("does not fail when sendNotification is undefined", async () => {
    const promise = sleep({ seconds: 5 }, {});
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;
    expect(result.success).toBe(true);
  });

  it("does not emit progress notifications when progressToken is absent", async () => {
    const sendNotification = vi.fn(() => Promise.resolve());
    const promise = sleep({ seconds: 5 }, { sendNotification }); // no progressToken
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;
    expect(result.success).toBe(true);
    // sendNotification should NOT be called without a progressToken
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("sends each tick through the job_progress side channel too, keyed by the running tool", async () => {
    const promise = runWithToolCallContext("libi.sleep", { seconds: 12, reason: "qa" }, () => sleep({ seconds: 12, reason: "qa" }, {}));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;
    const calls = vi.mocked(notify.toolProgress).mock.calls.map(([e]) => e);
    expect(calls.map((e) => e.message)).toEqual(["sleeping (qa) — 5/12s", "sleeping (qa) — 10/12s", "sleeping (qa) — 12/12s"]);
    expect(calls[0]).toMatchObject({ toolName: "libi.sleep", toolArgs: { seconds: 12, reason: "qa" }, done: 5000, total: 12000 });
  });
});
