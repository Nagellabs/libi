import { describe, it, expect } from "vitest";
import {
  initSupersampleState,
  nextSupersample,
  type SupersampleTuning,
} from "@/lib/preview/supersample-controller";

const CFG: SupersampleTuning = { maxCap: 2, minCap: 1, dropTicks: 3, recoverTicks: 6 };

/** Fold a sequence of stressed/healthy ticks, returning the final cap. */
function run(seq: boolean[], start = initSupersampleState(CFG.maxCap)): number {
  let s = start;
  for (const stressed of seq) s = nextSupersample(s, stressed, CFG);
  return s.cap;
}

describe("nextSupersample", () => {
  it("starts at the max cap", () => {
    expect(initSupersampleState(2).cap).toBe(2);
  });

  it("drops to the floor after dropTicks consecutive stressed ticks", () => {
    expect(run([true, true])).toBe(2); // not yet
    expect(run([true, true, true])).toBe(1); // hits dropTicks
  });

  it("a single healthy tick resets the stress streak (no premature drop)", () => {
    // 2 stressed, 1 healthy, 2 stressed → never 3 in a row → stays at max.
    expect(run([true, true, false, true, true])).toBe(2);
  });

  it("restores to the max cap only after recoverTicks healthy ticks", () => {
    const dropped = (() => {
      let s = initSupersampleState(CFG.maxCap);
      for (const x of [true, true, true]) s = nextSupersample(s, x, CFG);
      return s;
    })();
    expect(dropped.cap).toBe(1);
    // 5 healthy < recoverTicks(6) → still floored.
    expect(run([false, false, false, false, false], dropped)).toBe(1);
    // 6 healthy → restored.
    expect(run([false, false, false, false, false, false], dropped)).toBe(2);
  });

  it("does not flap: a stressed tick mid-recovery resets the calm streak", () => {
    let s = initSupersampleState(CFG.maxCap);
    for (const x of [true, true, true]) s = nextSupersample(s, x, CFG); // → cap 1
    // 5 healthy, then 1 stressed, then 5 healthy → never 6 clean in a row.
    for (const x of [false, false, false, false, false, true, false, false, false, false, false]) {
      s = nextSupersample(s, x, CFG);
    }
    expect(s.cap).toBe(1);
  });
});
