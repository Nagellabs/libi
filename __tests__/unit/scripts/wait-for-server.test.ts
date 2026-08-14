// __tests__/unit/scripts/wait-for-server.test.ts
import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { waitForServer, DEFAULT_TIMEOUT_MS, HARD_CAP_MS } = require("../../../scripts/lib/wait-for-server.js");

/** Virtual clock: `sleep` advances `now` — no real timers. */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    set: (v: number) => { t = v; },
  };
}

describe("waitForServer", () => {
  it("resolves as soon as the probe succeeds", async () => {
    const clock = makeClock();
    let calls = 0;
    await waitForServer({
      port: 1,
      probe: async () => ++calls >= 3,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(calls).toBe(3);
  });

  it("rejects after timeoutMs when there is no activity file", async () => {
    const clock = makeClock();
    await expect(
      waitForServer({
        port: 1,
        timeoutMs: 10_000,
        probe: async () => false,
        activityFile: null,
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toThrow(/did not respond/);
    expect(clock.now()).toBeLessThan(20_000); // no silent long overshoot
  });

  it("extends past timeoutMs while the activity file is fresh, then resolves", async () => {
    const clock = makeClock();
    let probeCalls = 0;
    let extended = 0;
    await waitForServer({
      port: 1,
      timeoutMs: 5_000,
      quietMs: 60_000,
      // Succeed at 100s — far beyond the 5s soft timeout.
      probe: async () => { probeCalls++; return clock.now() >= 100_000; },
      activityFile: "/fake/libi.log",
      activityMtime: () => clock.now() - 1_000, // always "written 1s ago"
      sleep: clock.sleep,
      now: clock.now,
      onExtend: () => extended++,
    });
    expect(clock.now()).toBeGreaterThanOrEqual(100_000);
    expect(extended).toBeGreaterThan(0);
    // Throttled: extends span ~95s past the 5s soft timeout, one notice / 30s.
    expect(extended).toBeLessThanOrEqual(4);
    expect(probeCalls).toBeGreaterThan(10);
  });

  it("throttles onExtend to at most one notice per 30s window", async () => {
    const clock = makeClock();
    let extended = 0;
    // Soft timeout 5s; probe succeeds at 100s → extend window is 5s..100s = 95s.
    // With a 30s throttle the notices fire at 5.5s, 35.5s, 65.5s, 95.5s = 4.
    await waitForServer({
      port: 1,
      timeoutMs: 5_000,
      quietMs: 60_000,
      probe: async () => clock.now() >= 100_000,
      activityFile: "/fake/libi.log",
      activityMtime: () => clock.now() - 1_000, // always fresh
      sleep: clock.sleep,
      now: clock.now,
      onExtend: () => extended++,
    });
    // An unthrottled loop (500ms/tick over ~95s) would emit ~190 notices.
    expect(extended).toBe(4);
  });

  it("rejects once the activity file goes quiet for quietMs", async () => {
    const clock = makeClock();
    await expect(
      waitForServer({
        port: 1,
        timeoutMs: 5_000,
        quietMs: 60_000,
        probe: async () => false,
        activityFile: "/fake/libi.log",
        activityMtime: () => 0, // last write at t=0, never again
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toThrow(/no boot activity/);
  });

  it("rejects at hardCapMs even with continuous activity", async () => {
    const clock = makeClock();
    await expect(
      waitForServer({
        port: 1,
        timeoutMs: 5_000,
        hardCapMs: 60_000,
        probe: async () => false,
        activityFile: "/fake/libi.log",
        activityMtime: () => clock.now(), // always fresh
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toThrow(/hard cap/);
  });

  it("exports sane defaults", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(180_000);
    expect(HARD_CAP_MS).toBe(1_200_000);
  });
});
