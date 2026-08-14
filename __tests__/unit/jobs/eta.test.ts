import { describe, it, expect } from "vitest";
import { EtaTracker, ETA_MIN_SPAN_MS } from "@/lib/jobs/eta";

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
});
