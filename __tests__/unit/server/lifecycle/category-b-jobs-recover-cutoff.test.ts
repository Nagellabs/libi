import { describe, expect, it, vi, afterEach } from "vitest";

/**
 * `defaultCategoryBDeps.recoverOrphanedJobs` wires the real dependency as
 * `() => recoverOrphanedJobsImpl(Date.now() - process.uptime() * 1000)` — a
 * process-start estimate, not the moment recovery actually runs (category A
 * can take a while first). The other lifecycle tests
 * (category-b.test.ts, runner.test.ts) stub `recoverOrphanedJobs` as a no-op,
 * so none of them exercise this expression. Mirrors the isolation style of
 * category-b-prewarm-tier.test.ts: mock the one leaf dependency and import
 * `defaultCategoryBDeps` fresh.
 */
describe("Category B jobs-recover cutoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a process-start estimate, not the moment recovery runs", async () => {
    const recoverOrphanedJobs = vi.fn(async () => {});
    vi.doMock("@/lib/jobs/scheduler", () => ({ recoverOrphanedJobs }));
    // Pretend this process has been up 2 minutes, so the expected cutoff is
    // unambiguously distinct from "now" regardless of how long the test
    // runner itself has been alive.
    vi.spyOn(process, "uptime").mockReturnValue(120);

    const { defaultCategoryBDeps } = await import("@/lib/server/lifecycle/category-b");
    const before = Date.now();
    await defaultCategoryBDeps.recoverOrphanedJobs();
    const after = Date.now();

    expect(recoverOrphanedJobs).toHaveBeenCalledOnce();
    const cutoff = recoverOrphanedJobs.mock.calls[0]![0] as number;
    // Roughly `now - 120s` — a generous +/-1s tolerance so this never flakes,
    // while still failing if the wiring regresses to plain `Date.now()`.
    expect(cutoff).toBeGreaterThanOrEqual(before - 120_000 - 1000);
    expect(cutoff).toBeLessThanOrEqual(after - 120_000 + 1000);
  });
});
