import { describe, it, expect } from "vitest";
import { mergeAnchorOverridesIntoTrack } from "@/lib/tracking/manual-anchors";
import { sampleTrack } from "@/lib/tracking/sample";
import type { Track } from "@/lib/tracking/types";

// Stable engine HEAD track: small head box near the top, centerY ~ 281, whole clip.
const head = Array.from({ length: 60 }, (_, i) => ({
  t: i / 30,
  x: 180,
  y: 255,
  w: 78,
  h: 52,
  confidence: 1,
  visible: true,
})); // centerX=219, centerY=281

function trk(extra: Partial<Track>): Track {
  return {
    id: "t",
    fileId: "f",
    label: "x",
    method: "yoloe+botsort",
    framerate: 30,
    durationSec: 2,
    samples: head.map((o) => ({ ...o })),
    segments: [
      {
        id: "seg-0-2000",
        startTime: 0,
        endTime: 2,
        method: "yoloe+botsort",
        status: "ok",
        samples: head.map((o) => ({ ...o })),
      },
    ],
    anchors: [],
    ...extra,
  } as unknown as Track;
}

// A torso-centered PERSON-box agent anchor (what ground_target / analysis give):
// centerX≈232, centerY≈390 (mid-torso). Pre-fix this dove the head to y≈390.
const personAnchor = (time: number, cx = 232) =>
  ({ id: `agt-${Math.round(time * 1000)}`, time, bbox: [cx - 81, 141, 162, 499] as [number, number, number, number] });

describe("agent anchor render-injection: trust engine head re-track", () => {
  it("REDUNDANT (engine head track agrees horizontally) → anchor skipped, no torso dive", () => {
    const t = trk({ agentAnchors: [personAnchor(1.0, 232)] }); // cx≈232 ≈ track centerX 219
    const merged = mergeAnchorOverridesIntoTrack(t);
    const at = sampleTrack(merged, 1.0, "linear")!;
    const cy = at.y + at.h / 2;
    expect(cy).toBeLessThan(310); // stays on the HEAD
    expect(Math.abs(cy - 281)).toBeLessThan(15); // ~ the engine head track
  });

  it("DRIFT (engine confidently on wrong subject) → injected as a HEAD box at the corrected x, head level — never the torso", () => {
    // Engine track is at centerX≈219; anchor says the real subject is far left.
    const t = trk({ agentAnchors: [personAnchor(1.0, 90)] }); // cx=90, far from 219
    const merged = mergeAnchorOverridesIntoTrack(t);
    const at = sampleTrack(merged, 1.0, "linear")!;
    expect(at.x + at.w / 2).toBeLessThan(140); // moved horizontally onto the corrected subject
    const cy = at.y + at.h / 2;
    expect(cy).toBeLessThan(330); // HEAD level (≈281), NOT the torso (~390)
    expect(at.h).toBeLessThan(120); // head-sized, not the 499-tall person box
  });

  it("LOST (engine has no confident box here) → injected as a head-from-top fallback, head-sized, not torso", () => {
    const lost = head.map((o) =>
      Math.abs(o.t - 1.0) <= 0.4 ? { ...o, visible: false } : { ...o },
    );
    const t = trk({
      samples: lost,
      segments: [
        { id: "seg-0-2000", startTime: 0, endTime: 2, method: "yoloe+botsort", status: "ok", samples: lost },
      ],
      agentAnchors: [personAnchor(1.0, 232)],
    });
    const merged = mergeAnchorOverridesIntoTrack(t) as Track;
    // The fix's contract is the injected box GEOMETRY: a visible head-sized
    // keyframe at the anchor time, head-from-top — NEVER the torso. (Whether
    // sampleTrack flags a point inside an invisible run as visible is a
    // separate, pre-existing sampleTrack concern, unchanged by this fix.)
    const kf = merged.samples.find((s) => Math.abs(s.t - 1.0) < 1e-6)!;
    expect(kf.visible).toBe(true);
    expect(kf.y + kf.h / 2).toBeLessThan(260); // head-from-top, NOT torso (~390)
    expect(kf.h).toBeLessThan(120); // head-sized, not the 499-tall person box
    expect(sampleTrack(merged, 1.0, "linear")!.y).toBe(kf.y); // box geometry honored
  });

  it("MANUAL anchors are never skipped or head-rewritten — a same-subject drag applies literally", () => {
    const t = trk({
      manualAnchors: [{ id: "man-1000", time: 1.0, bbox: [180, 230, 78, 52] }],
    }); // deliberate small upward nudge, centerY=256
    const merged = mergeAnchorOverridesIntoTrack(t);
    const at = sampleTrack(merged, 1.0, "linear")!;
    expect(Math.abs(at.y + at.h / 2 - 256)).toBeLessThan(6); // honored as-is
  });

  it("MANUAL outranks a colliding agent anchor at the same time (precedence manual > agent)", () => {
    const t = trk({
      agentAnchors: [personAnchor(1.0, 90)], // would drift-inject at x≈90
      manualAnchors: [{ id: "man-1000", time: 1.0, bbox: [300, 240, 78, 52] }],
    });
    const merged = mergeAnchorOverridesIntoTrack(t);
    const at = sampleTrack(merged, 1.0, "linear")!;
    expect(Math.abs(at.x + at.w / 2 - 339)).toBeLessThan(6); // manual's x wins
  });
});
