import { describe, it, expect } from "vitest";
import { planMountWindow, type MountClip } from "@/lib/preview/mount-window";

const clip = (id: string, startSec: number, endSec: number): MountClip => ({ id, startSec, endSec });

describe("planMountWindow", () => {
  it("always mounts an active clip regardless of window sizes", () => {
    const keep = planMountWindow({
      playheadSec: 5,
      clips: [clip("a", 4, 6)],
      aheadSec: 0,
      behindSec: 0,
    });
    expect(keep.has("a")).toBe(true);
  });

  it("mounts an upcoming clip within aheadSec, not one beyond it", () => {
    const clips = [clip("near", 6, 8), clip("far", 10, 12)];
    const keep = planMountWindow({ playheadSec: 5, clips, aheadSec: 2, behindSec: 1 });
    expect(keep.has("near")).toBe(true); // starts 1s ahead ≤ 2
    expect(keep.has("far")).toBe(false); // starts 5s ahead > 2
  });

  it("keeps a just-ended clip within behindSec (scrub-back), drops older", () => {
    const clips = [clip("recent", 3, 4.5), clip("old", 0, 1)];
    const keep = planMountWindow({ playheadSec: 5, clips, aheadSec: 2, behindSec: 1 });
    expect(keep.has("recent")).toBe(true); // ended 0.5s ago ≤ 1
    expect(keep.has("old")).toBe(false); // ended 4s ago > 1
  });

  it("boundary is inclusive at exactly aheadSec / behindSec", () => {
    const clips = [clip("aheadEdge", 7, 9), clip("behindEdge", 2, 4)];
    const keep = planMountWindow({ playheadSec: 5, clips, aheadSec: 2, behindSec: 1 });
    expect(keep.has("aheadEdge")).toBe(true); // 7-5 === 2
    expect(keep.has("behindEdge")).toBe(true); // 5-4 === 1
  });

  it("sequential timeline: mounts only the window subset (the decoder-count win)", () => {
    // 10 back-to-back 1s clips; playhead at 5.5, ahead=2, behind=1.
    const clips = Array.from({ length: 10 }, (_, i) => clip(`c${i}`, i, i + 1));
    const keep = planMountWindow({ playheadSec: 5.5, clips, aheadSec: 2, behindSec: 1 });
    // active c5 [5,6); recent c4 [4,5) ended 0.5s ago; upcoming c6 [6,7) +0.5, c7 [7,8) +1.5.
    expect([...keep].sort()).toEqual(["c4", "c5", "c6", "c7"]);
    expect(keep.size).toBe(4); // 4 of 10 mounted — 6 decoders reclaimed
  });

  it("parallel N-up: all overlapping clips are active ⇒ all mounted (scope limit)", () => {
    // 12 fully-overlapping clips (0..10). Proximity can't reduce this — they're all active.
    const clips = Array.from({ length: 12 }, (_, i) => clip(`v${i}`, 0, 10));
    const keep = planMountWindow({ playheadSec: 3, clips, aheadSec: 2, behindSec: 1 });
    expect(keep.size).toBe(12);
  });

  it("a wider (dispose) window is a superset of the narrower (mount) window — hysteresis", () => {
    const clips = [clip("boundary", 7.5, 9)]; // 2.5s ahead
    const mount = planMountWindow({ playheadSec: 5, clips, aheadSec: 2, behindSec: 1 });
    const keepAlive = planMountWindow({ playheadSec: 5, clips, aheadSec: 3, behindSec: 2 });
    expect(mount.has("boundary")).toBe(false); // not yet in the mount window
    expect(keepAlive.has("boundary")).toBe(true); // but inside the dispose window → stays if already mounted
  });
});
