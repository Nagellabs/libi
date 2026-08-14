import { describe, it, expect } from "vitest";
import {
  dragToTiming,
  timingReflects,
  resolveHeldTiming,
  orderForVerticalDrop,
  type ClipTiming,
  type StackOrderRow,
} from "@/lib/preview/audio-clip-drag";

const base: ClipTiming = { startTime: 5, duration: 10 };

describe("audio-clip-drag — dragToTiming", () => {
  it("converts a positive px delta into a later start (duration unchanged)", () => {
    // 100px / 50px-per-sec = +2s.
    expect(dragToTiming(base, 100, 50)).toEqual({ startTime: 7, duration: 10 });
  });

  it("converts a negative px delta into an earlier start", () => {
    expect(dragToTiming(base, -100, 50)).toEqual({ startTime: 3, duration: 10 });
  });

  it("clamps the start at 0 (can't drag before the timeline origin)", () => {
    // -500px / 50 = -10s, but start can't go below 0 (was 5).
    expect(dragToTiming(base, -500, 50)).toEqual({ startTime: 0, duration: 10 });
  });

  it("is a no-op when pxPerSec is degenerate (0)", () => {
    expect(dragToTiming(base, 100, 0)).toEqual({ startTime: 5, duration: 10 });
  });
});

describe("audio-clip-drag — timingReflects", () => {
  it("true within a sub-millisecond epsilon", () => {
    expect(timingReflects({ startTime: 7.0000001, duration: 10 }, { startTime: 7, duration: 10 })).toBe(true);
  });
  it("false on a meaningful start difference", () => {
    expect(timingReflects({ startTime: 5, duration: 10 }, { startTime: 7, duration: 10 })).toBe(false);
  });
  it("false on a duration difference", () => {
    expect(timingReflects({ startTime: 7, duration: 9 }, { startTime: 7, duration: 10 })).toBe(false);
  });
});

describe("audio-clip-drag — resolveHeldTiming (optimistic-hold)", () => {
  it("with no held value, displays the prop and never releases", () => {
    expect(resolveHeldTiming(base, null)).toEqual({ display: base, release: false });
  });

  it("DISPLAYS the held value while the prop is still stale (the no-flash guarantee)", () => {
    // The drag committed startTime 7; the prop still carries the pre-drag 5
    // (server round-trip in flight). Display the HELD 7 so the bar never flashes
    // back to 5 on release.
    const held = { startTime: 7, duration: 10 };
    const stale = { startTime: 5, duration: 10 };
    expect(resolveHeldTiming(stale, held)).toEqual({ display: held, release: false });
  });

  it("RELEASES once the prop reflects the held value (display the prop, drop the hold)", () => {
    const held = { startTime: 7, duration: 10 };
    const caughtUp = { startTime: 7, duration: 10 };
    const out = resolveHeldTiming(caughtUp, held);
    expect(out.release).toBe(true);
    expect(out.display).toEqual(caughtUp);
  });

  it("keeps holding when a LATER stale refetch returns an even-older position", () => {
    // A stale refresh_query from an EARLIER drag returns startTime 3; the hold
    // (7) must still win so there is no intermediate flash.
    const held = { startTime: 7, duration: 10 };
    expect(resolveHeldTiming({ startTime: 3, duration: 10 }, held)).toEqual({
      display: held,
      release: false,
    });
  });
});

describe("audio-clip-drag — orderForVerticalDrop (detached-track fractional indexing)", () => {
  // A stack of three overlay rows (z 3 / 2 / 1, top→bottom) plus the dragged
  // detached audio track. Each row spans 20px; rows packed top→bottom.
  const stack = (draggedKey: number): StackOrderRow[] => [
    { id: "ov-a", key: 3, top: 0, bottom: 20 },
    { id: "ov-b", key: 2, top: 20, bottom: 40 },
    { id: "ov-c", key: 1, top: 40, bottom: 60 },
    { id: "audio", key: draggedKey, top: 60, bottom: 80 },
  ];

  it("drop ABOVE all rows → topKey + 1", () => {
    // Pointer above the first row's midpoint (10) → slot 0 → 3 + 1.
    expect(orderForVerticalDrop(stack(2.5), "audio", 5)).toBe(4);
  });

  it("drop BELOW all rows → bottomKey − 1", () => {
    // Pointer below the last OTHER row's midpoint (ov-c mid = 50) → slot = end.
    expect(orderForVerticalDrop(stack(2.5), "audio", 100)).toBe(0); // 1 − 1
  });

  it("drop in the MIDDLE (between ov-a and ov-b) → midpoint of their keys", () => {
    // Pointer past ov-a's midpoint (10) but at/before ov-b's midpoint (30) → slot 1.
    // Between upper ov-a (3) and lower ov-b (2) → 2.5.
    expect(orderForVerticalDrop(stack(0.5), "audio", 25)).toBe(2.5);
  });

  it("drop between two overlays lower in the stack → their midpoint", () => {
    // Pointer at 45: past ov-b's midpoint (30), at/before ov-c's midpoint (50)
    // → slot 2. Between ov-b (2) and ov-c (1) → 1.5.
    expect(orderForVerticalDrop(stack(0.5), "audio", 45)).toBe(1.5);
  });

  it("drop between an overlay and a sibling detached track → their midpoint", () => {
    // Two detached tracks: the dragged one + a sibling at key 1.5 between ov-b and
    // ov-c. Dropping the dragged track just above the sibling lands between ov-b
    // (2) and the sibling (1.5) → 1.75.
    const rows: StackOrderRow[] = [
      { id: "ov-a", key: 3, top: 0, bottom: 20 },
      { id: "ov-b", key: 2, top: 20, bottom: 40 },
      { id: "audio-sib", key: 1.5, top: 40, bottom: 60 },
      { id: "ov-c", key: 1, top: 60, bottom: 80 },
      { id: "audio", key: 0.5, top: 80, bottom: 100 },
    ];
    // Pointer at 45: past ov-b mid (30), at/before sibling mid (50) → slot between
    // ov-b (2) and sibling (1.5) → 1.75.
    expect(orderForVerticalDrop(rows, "audio", 45)).toBe(1.75);
  });

  it("returns null when there are no OTHER rows to position against", () => {
    expect(
      orderForVerticalDrop([{ id: "audio", key: 1, top: 0, bottom: 20 }], "audio", 10),
    ).toBeNull();
  });
});
