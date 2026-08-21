import { describe, it, expect } from "vitest";
import { EtaTracker, ETA_MIN_SPAN_MS, remainingMs } from "@/lib/jobs/eta";

describe("EtaTracker", () => {
  it("returns null before the gate (few samples / short span / low done)", () => {
    const t = new EtaTracker();
    t.add(0, 1);
    expect(t.etaMs(750, 1)).toBeNull(); // one sample, no span
    t.add(1000, 2);
    expect(t.etaMs(750, 2)).toBeNull(); // span 1s < 5s
    t.add(ETA_MIN_SPAN_MS + 1000, 2);
    expect(t.etaMs(750, 2)).toBeNull(); // done 2 < 3
  });

  it("ignores slow startup outside the window (the 23.8-min inflation case)", () => {
    const t = new EtaTracker();
    // 60s of model load with barely any progress. This startup is extreme
    // enough that a broken tracker that never evicts (lifetime average over
    // all samples: 90s / 305 units ≈ 295 ms/unit → ETA ≈ 131s) FAILS the
    // < 60s bound below — the assertion pins the sliding window itself,
    // not just "some bounded value".
    t.add(0, 0);
    t.add(60_000, 5);
    // ...then steady 10 units/sec for 30 samples (window keeps last 20).
    for (let i = 1; i <= 30; i++) t.add(60_000 + i * 1000, 5 + i * 10);
    const eta = t.etaMs(750, 305)!;
    // Remaining 445 units at ~100ms/unit ≈ 44.5s — nowhere near lifetime avg.
    expect(eta).toBeGreaterThan(30_000);
    expect(eta).toBeLessThan(60_000);
  });

  it("counts down monotonically at a constant rate", () => {
    const t = new EtaTracker();
    const etas: number[] = [];
    for (let i = 0; i <= 20; i++) {
      t.add(i * 1000, i * 10);
      const e = t.etaMs(300, i * 10);
      if (e !== null) etas.push(e);
    }
    expect(etas.length).toBeGreaterThan(3);
    for (let i = 1; i < etas.length; i++) expect(etas[i]).toBeLessThanOrEqual(etas[i - 1]);
  });

  it("returns null when the window shows zero progress (stall)", () => {
    const t = new EtaTracker();
    for (let i = 0; i <= 25; i++) t.add(i * 1000, 50); // done frozen at 50
    expect(t.etaMs(100, 50)).toBeNull();
  });

  // The case above only catches a stall that keeps TICKING (add() called with an
  // unchanged `done`). The ACE-Step download stalled differently and invisibly:
  // no tick arrives at all for 24 minutes, so the window keeps its last healthy
  // samples and happily quotes the rate it measured before going quiet.
  it("withdraws the estimate once the wait has outlived it", () => {
    const t = new EtaTracker();
    // Steady 1 unit/sec to 10/12 — two units left, so ~2s predicted.
    for (let i = 0; i <= 10; i++) t.add(i * 1000, i);
    const atTick = t.etaMs(12, 10);
    expect(atTick).not.toBeNull();
    expect(atTick!).toBeGreaterThan(0);

    // Same samples, read 1s later: the estimate has decayed, not frozen.
    const decayed = t.etaMs(12, 10, 10_000 + 1000)!;
    expect(decayed).toBeLessThan(atTick!);

    // Read 15 MINUTES later with no new sample — the old code returned the
    // very same `atTick` value here, which is the reported bug.
    expect(t.etaMs(12, 10, 10_000 + 15 * 60_000)).toBeNull();
  });

  it("without `now`, behaves exactly as before (tick-time callers unaffected)", () => {
    const t = new EtaTracker();
    for (let i = 0; i <= 10; i++) t.add(i * 1000, i);
    expect(t.etaMs(12, 10)).toBe(t.etaMs(12, 10, 10_000));
  });
});

describe("remainingMs", () => {
  it("is null without a total or a rate — never a fake zero", () => {
    expect(remainingMs({ total: 0, done: 0, msPerUnit: 100 })).toBeNull();
    expect(remainingMs({ total: 10, done: 1, msPerUnit: null })).toBeNull();
    expect(remainingMs({ total: 10, done: 1, msPerUnit: 0 })).toBeNull();
  });

  it("is 0 only when the work is actually done", () => {
    expect(remainingMs({ total: 10, done: 10, msPerUnit: 100 })).toBe(0);
    // Over-reported done clamps rather than going negative.
    expect(remainingMs({ total: 10, done: 11, msPerUnit: 100 })).toBe(0);
  });

  it("decays by the time already waited", () => {
    expect(
      remainingMs({ total: 10, done: 8, msPerUnit: 1000, msSinceProgress: 0 }),
    ).toBe(2000);
    expect(
      remainingMs({ total: 10, done: 8, msPerUnit: 1000, msSinceProgress: 500 }),
    ).toBe(1500);
  });

  it("withdraws rather than clamping to zero when outlived", () => {
    // Predicted 2s, already waited 2s: we no longer know. Returning 0 here
    // would render "ETA 0s" on a job that may have twenty minutes left.
    expect(
      remainingMs({ total: 10, done: 8, msPerUnit: 1000, msSinceProgress: 2000 }),
    ).toBeNull();
    expect(
      remainingMs({ total: 10, done: 8, msPerUnit: 1000, msSinceProgress: 999_999 }),
    ).toBeNull();
  });

  it("reproduces the ACE-Step shape: file units hide a 6 GB file", () => {
    // 11 of 12 files done, ~65s/file measured across the small config files.
    // Predicted ~1m 5s — the number that sat on screen for fifteen minutes.
    const atTick = remainingMs({
      total: 12,
      done: 11,
      msPerUnit: 65_000,
      msSinceProgress: 0,
    });
    expect(atTick).toBe(65_000);
    // Fifteen minutes into the single 6.2 GB file, with no tick since.
    expect(
      remainingMs({
        total: 12,
        done: 11,
        msPerUnit: 65_000,
        msSinceProgress: 15 * 60_000,
      }),
    ).toBeNull();
  });
});
