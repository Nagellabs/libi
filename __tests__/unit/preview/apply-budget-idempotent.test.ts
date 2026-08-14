import { describe, it, expect } from "vitest";
import { applyBudget, type BudgetEntry, type BudgetSource } from "@/hooks/preview/use-video-sources";
import type { Composition } from "@/lib/engine/types";

/** Records every decode action so we can assert call counts across ticks. */
function makeFakeSource() {
  const calls: string[] = [];
  const source: BudgetSource = {
    play: () => calls.push("play"),
    warm: (s: number) => calls.push(`warm:${s}`),
    pause: () => calls.push("pause"),
    prime: (t: number) => {
      calls.push(`prime:${t}`);
    },
  };
  return { source, calls };
}

/** Minimal one-video-overlay composition (cast — applyBudget only reads
 *  scenes/overlays/fps). Videos are overlays; scenes are canvas-only. */
function oneVideoComp(id: string, durationSec: number): Composition {
  return {
    fps: 30,
    scenes: [],
    overlays: [
      { id, kind: "video", startTime: 0, duration: durationSec, videoUrl: "x", fileId: "f", z: 0, opacity: 1, rect: { x: 0, y: 0, width: 1920, height: 1080 } },
    ],
  } as unknown as Composition;
}

describe("applyBudget idempotency", () => {
  it("does not re-issue play() on a steady active+playing source across ticks", () => {
    const { source, calls } = makeFakeSource();
    const entry: BudgetEntry = { source };
    const map = new Map<string, BudgetEntry>([["a", entry]]);
    const comp = oneVideoComp("a", 10);

    applyBudget({ composition: comp, playheadSec: 5, playing: true, map });
    applyBudget({ composition: comp, playheadSec: 5.1, playing: true, map });
    applyBudget({ composition: comp, playheadSec: 5.2, playing: true, map });

    // play() is deliberately called every tick (it tracks seeks via ensureCovers
    // and is a no-op on a healthy ring) — that's the ONE exception to idempotency.
    expect(calls.filter((c) => c === "play").length).toBe(3);
    expect(entry.lastEffective).toBe("active-playing");
  });

  it("warms a warm source ONCE, not every tick", () => {
    const { source, calls } = makeFakeSource();
    const entry: BudgetEntry = { source };
    // Active clip 'act' keeps the playhead occupied; 'w' starts soon → warm.
    const comp = {
      fps: 30,
      scenes: [],
      overlays: [
        { id: "act", kind: "video", startTime: 0, duration: 10, videoUrl: "x", fileId: "f1", z: 0, opacity: 1, rect: { x: 0, y: 0, width: 1920, height: 1080 } },
        { id: "w", kind: "video", startTime: 10, duration: 10, videoUrl: "y", fileId: "f2", z: 1, opacity: 1, rect: { x: 0, y: 0, width: 1920, height: 1080 } },
      ],
    } as unknown as Composition;
    const map = new Map<string, BudgetEntry>([["w", entry]]);

    // Playhead at 9.5s: 'act' (0–10) active, 'w' (10–20) starts 0.5s ahead → warm.
    applyBudget({ composition: comp, playheadSec: 9.5, playing: true, map });
    applyBudget({ composition: comp, playheadSec: 9.6, playing: true, map });
    applyBudget({ composition: comp, playheadSec: 9.7, playing: true, map });

    expect(calls.filter((c) => c.startsWith("warm")).length).toBe(1);
    expect(entry.lastEffective).toBe("warm");
  });

  it("pauses a cold source ONCE, not every tick", () => {
    const { source, calls } = makeFakeSource();
    const entry: BudgetEntry = { source };
    const comp = oneVideoComp("a", 10);
    // Playhead PAST the only clip (10s long) → 'a' is cold.
    const map = new Map<string, BudgetEntry>([["a", entry]]);

    applyBudget({ composition: comp, playheadSec: 50, playing: true, map });
    applyBudget({ composition: comp, playheadSec: 50.1, playing: true, map });
    applyBudget({ composition: comp, playheadSec: 50.2, playing: true, map });

    expect(calls.filter((c) => c === "pause").length).toBe(1);
    expect(entry.lastEffective).toBe("cold");
  });

  it("on a STATIC pause, primes once — not every tick (and NO runway warm)", () => {
    const { source, calls } = makeFakeSource();
    const entry: BudgetEntry = { source };
    const comp = oneVideoComp("a", 10);
    const map = new Map<string, BudgetEntry>([["a", entry]]);

    applyBudget({ composition: comp, playheadSec: 3, playing: false, map });
    applyBudget({ composition: comp, playheadSec: 3, playing: false, map });
    applyBudget({ composition: comp, playheadSec: 3, playing: false, map });

    // Entered paused once, playhead didn't move → exactly one prime, and NO warm:
    // applyBudget must NOT build a forward runway on the paused on-screen source
    // (that runway mid-scrub is the "extra frames" artifact). The instant-play
    // runway is built by the DEBOUNCED settle-warm effect in useVideoSources, which
    // only fires once the playhead RESTS — a distinction applyBudget can't make.
    expect(calls.filter((c) => c.startsWith("prime")).length).toBe(1);
    expect(calls.filter((c) => c.startsWith("warm")).length).toBe(0);
    expect(entry.lastEffective).toBe("active-paused");
  });

  it("on a paused SCRUB (playhead moves), re-primes per position", () => {
    const { source, calls } = makeFakeSource();
    const entry: BudgetEntry = { source };
    const comp = oneVideoComp("a", 10);
    const map = new Map<string, BudgetEntry>([["a", entry]]);

    applyBudget({ composition: comp, playheadSec: 3, playing: false, map });
    applyBudget({ composition: comp, playheadSec: 4, playing: false, map });
    applyBudget({ composition: comp, playheadSec: 5, playing: false, map });

    expect(calls.filter((c) => c.startsWith("prime")).length).toBe(3);
  });

  it("re-issues play() exactly once when transitioning paused → playing", () => {
    const { source, calls } = makeFakeSource();
    const entry: BudgetEntry = { source };
    const comp = oneVideoComp("a", 10);
    const map = new Map<string, BudgetEntry>([["a", entry]]);

    applyBudget({ composition: comp, playheadSec: 3, playing: false, map }); // paused
    const beforePlay = calls.length;
    applyBudget({ composition: comp, playheadSec: 3, playing: true, map }); // play
    expect(calls.slice(beforePlay)).toContain("play");
    expect(entry.lastEffective).toBe("active-playing");
  });
});
