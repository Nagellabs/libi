import { describe, it, expect } from "vitest";
import { normalizeTrack } from "@/lib/tracking/segments";
import type { Track, AgentAnchor } from "@/lib/tracking/types";

describe("AgentAnchor type + Track.agentAnchors", () => {
  it("normalizeTrack preserves agentAnchors (spread passthrough)", () => {
    const a: AgentAnchor = { id: "agt-3000", time: 3, bbox: [1, 2, 3, 4] };
    const track: Track = {
      id: "t", fileId: "f", method: "yoloe+botsort", framerate: 30, durationSec: 5,
      samples: [{ t: 0, x: 0, y: 0, w: 1, h: 1, confidence: 1, visible: true }],
      segments: [{ id: "seg-0-5000", startTime: 0, endTime: 5, method: "yoloe+botsort", status: "ok",
        samples: [{ t: 0, x: 0, y: 0, w: 1, h: 1, confidence: 1, visible: true }] }],
      agentAnchors: [a],
    };
    expect(normalizeTrack(track).agentAnchors).toEqual([a]);
  });
});

import { agentAnchorId, upsertAgentAnchor } from "@/lib/tracking/manual-anchors";

describe("agent anchor helpers", () => {
  it("agentAnchorId is deterministic agt-<ms>", () => {
    expect(agentAnchorId(2.5)).toBe("agt-2500");
    expect(agentAnchorId(0)).toBe("agt-0");
  });
  it("upsertAgentAnchor replaces by id and sorts by time", () => {
    const a = { id: agentAnchorId(2), time: 2, bbox: [1, 1, 1, 1] as [number, number, number, number] };
    const b = { id: agentAnchorId(1), time: 1, bbox: [2, 2, 2, 2] as [number, number, number, number] };
    const a2 = { id: agentAnchorId(2), time: 2, bbox: [9, 9, 9, 9] as [number, number, number, number] };
    let list = upsertAgentAnchor([], a);
    list = upsertAgentAnchor(list, b);
    list = upsertAgentAnchor(list, a2); // replaces a (same id)
    expect(list.map((x) => x.time)).toEqual([1, 2]);
    expect(list.find((x) => x.time === 2)!.bbox).toEqual([9, 9, 9, 9]);
    expect(list.length).toBe(2);
  });
});

import { mergeAnchorOverridesIntoTrack } from "@/lib/tracking/manual-anchors";
import { sampleTrack } from "@/lib/tracking/sample";

function s(t: number, x: number) {
  return { t, x, y: 0, w: 10, h: 10, confidence: 1, visible: true };
}

describe("mergeAnchorOverridesIntoTrack (manual > agent > engine)", () => {
  const base: Track = {
    id: "t", fileId: "f", method: "yoloe+botsort", framerate: 10, durationSec: 1,
    samples: [s(0, 0), s(0.5, 50), s(1, 100)],
    segments: [{ id: "seg-0-1000", startTime: 0, endTime: 1, method: "yoloe+botsort", status: "ok",
      samples: [s(0, 0), s(0.5, 50), s(1, 100)] }],
  };

  // Sentinel boxes are sized to the track samples (10×10) so the F2 anchor
  // size-reconciliation (clamps boxes far off the track envelope, center-
  // preserving) is a no-op here — these assert precedence/stamping (which
  // anchor's x wins), not size. Size reconciliation has its own test
  // (anchor-size-reconcile.test.ts).
  it("agent anchor stamps when no manual at that time", () => {
    const t = { ...base, agentAnchors: [{ id: "agt-500", time: 0.5, bbox: [777, 0, 10, 10] as [number, number, number, number] }] };
    expect(sampleTrack(mergeAnchorOverridesIntoTrack(t), 0.5, "linear")?.x).toBe(777);
  });

  it("manual outranks agent on a time collision", () => {
    const t = {
      ...base,
      agentAnchors: [{ id: "agt-500", time: 0.5, bbox: [777, 0, 10, 10] as [number, number, number, number] }],
      manualAnchors: [{ id: "man-500", time: 0.5, bbox: [42, 0, 10, 10] as [number, number, number, number] }],
    };
    expect(sampleTrack(mergeAnchorOverridesIntoTrack(t), 0.5, "linear")?.x).toBe(42);
  });

  it("both channels empty → SAME track reference (memoization-safe)", () => {
    expect(mergeAnchorOverridesIntoTrack(base)).toBe(base);
  });

  it("mergeManualAnchorsIntoTrack behavior unchanged (still pins manual)", async () => {
    const t = { ...base, manualAnchors: [{ id: "man-500", time: 0.5, bbox: [9, 0, 10, 10] as [number, number, number, number] }] };
    const { mergeManualAnchorsIntoTrack } = await import("@/lib/tracking/manual-anchors");
    expect(sampleTrack(mergeManualAnchorsIntoTrack(t), 0.5, "linear")?.x).toBe(9);
  });
});
