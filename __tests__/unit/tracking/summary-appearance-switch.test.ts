// __tests__/unit/tracking/summary-appearance-switch.test.ts
import { describe, it, expect } from "vitest";
import { summarizeTrack } from "@/lib/tracking/summary";
import { normalizeTrack } from "@/lib/tracking/segments";
import type { Track, TrackSample } from "@/lib/tracking/types";

const W = 360;
const H = 640;

function mk(samples: TrackSample[]): Track {
  return normalizeTrack({
    id: "trk",
    fileId: "f",
    method: "yoloe+botsort",
    framerate: 30,
    durationSec: samples[samples.length - 1].t + 0.05,
    samples,
  });
}
const sum = (t: Track) =>
  summarizeTrack(t, { frameW: W, frameH: H, clipDurationSec: 40 });

describe("summarizeTrack — appearance-based identity_switch_suspected", () => {
  it("flags a sustained (>=0.5s) low-targetSim run while kinematically continuous", () => {
    const s: TrackSample[] = [];
    // 1.0s good (sim 0.8), then 1.0s on a different subject (sim 0.15),
    // same screen region (no teleport) — geometric heuristic would miss it.
    for (let i = 0; i < 30; i++)
      s.push({ t: i / 30, x: 140, y: 200, w: 90, h: 130, confidence: 0.9, visible: true, targetSim: 0.8 });
    for (let i = 30; i < 60; i++)
      s.push({ t: i / 30, x: 142, y: 202, w: 92, h: 132, confidence: 0.9, visible: true, targetSim: 0.15 });
    const r = sum(mk(s));
    expect(r.flags).toContain("identity_switch_suspected");
    const iss = r.issues.find((x) => x.kind === "identity_switch_suspected");
    expect(iss).toBeDefined();
    expect(iss!.range.start).toBeGreaterThanOrEqual(0.9);
    expect(iss!.range.end).toBeLessThanOrEqual(2.0);
    expect(iss!.detail).toContain("Do NOT skip_segment");
  });

  it("does NOT flag a fast geometric move when targetSim stays high", () => {
    const s: TrackSample[] = [];
    for (let i = 0; i < 20; i++)
      s.push({ t: i / 30, x: 20, y: 100, w: 80, h: 120, confidence: 0.9, visible: true, targetSim: 0.85 });
    for (let i = 20; i < 60; i++)
      s.push({ t: i / 30, x: 260, y: 110, w: 80, h: 120, confidence: 0.9, visible: true, targetSim: 0.82 });
    const r = sum(mk(s));
    expect(r.flags).not.toContain("identity_switch_suspected");
  });

  it("does NOT flag a sub-0.5s low-sim blip (boundary pin)", () => {
    const s: TrackSample[] = [];
    for (let i = 0; i < 30; i++)
      s.push({ t: i / 30, x: 140, y: 200, w: 90, h: 130, confidence: 0.9, visible: true, targetSim: 0.8 });
    for (let i = 30; i < 42; i++) // 12 frames @30fps = 0.4s < 0.5s
      s.push({ t: i / 30, x: 140, y: 200, w: 90, h: 130, confidence: 0.9, visible: true, targetSim: 0.1 });
    for (let i = 42; i < 60; i++)
      s.push({ t: i / 30, x: 140, y: 200, w: 90, h: 130, confidence: 0.9, visible: true, targetSim: 0.8 });
    const r = sum(mk(s));
    expect(r.flags).not.toContain("identity_switch_suspected");
  });

  it("falls back to the geometric teleport heuristic when all targetSim are null", () => {
    const s: TrackSample[] = [];
    for (let i = 0; i < 15; i++)
      s.push({ t: i / 30, x: 20, y: 100, w: 60, h: 90, confidence: 0.9, visible: true });
    for (let i = 15; i < 60; i++)
      s.push({ t: i / 30, x: 280, y: 480, w: 60, h: 90, confidence: 0.9, visible: true });
    const r = sum(mk(s));
    expect(r.flags).toContain("identity_switch_suspected");
  });
});

function lowRun(): Track["samples"] {
  // 1.0s of visible, targetSim 0.6 (sustained, < tau)
  return Array.from({ length: 11 }, (_, i) => ({
    t: 4 + i / 10, x: 10, y: 10, w: 20, h: 20,
    confidence: 1, visible: true, targetSim: 0.6,
  }));
}
const opts = { frameW: 1920, frameH: 1080, clipDurationSec: 60 };

describe("appearance_unverified_occlusion vs identity_switch_suspected", () => {
  it("uncovered sustained low-sim visible run ⇒ identity_switch_suspected (blocking)", () => {
    const t: Track = { id: "t", fileId: "f", method: "yoloe+botsort",
      framerate: 30, durationSec: 6, samples: lowRun() };
    const s = summarizeTrack(t, opts);
    expect(s.flags).toContain("identity_switch_suspected");
    expect(s.flags).not.toContain("appearance_unverified_occlusion");
  });

  it("an agent anchor inside the run ⇒ appearance_unverified_occlusion (non-blocking)", () => {
    const t: Track = { id: "t", fileId: "f", method: "yoloe+botsort",
      framerate: 30, durationSec: 6, samples: lowRun(),
      agentAnchors: [{ id: "agt-4500", time: 4.5, bbox: [10, 10, 20, 20] }] };
    const s = summarizeTrack(t, opts);
    expect(s.flags).toContain("appearance_unverified_occlusion");
    expect(s.flags).not.toContain("identity_switch_suspected");
  });

  it("a manual anchor inside the run also yields the non-blocking flag", () => {
    const t: Track = { id: "t", fileId: "f", method: "yoloe+botsort",
      framerate: 30, durationSec: 6, samples: lowRun(),
      manualAnchors: [{ id: "man-4500", time: 4.5, bbox: [10, 10, 20, 20] }] };
    expect(summarizeTrack(t, opts).flags)
      .toContain("appearance_unverified_occlusion");
  });

  it("covered run THEN later uncovered run ⇒ BOTH flags", () => {
    // First low-sim run at t=4..5 (1.0s ≥ MIN_SWITCH_SEC=0.5), covered by an anchor
    const firstRun = lowRun(); // t: 4.0..5.0, targetSim: 0.6
    // High-sim gap: t=5.1..5.9 (8 samples at 0.95 — not low-sim so ranges() splits them off)
    const highGap = Array.from({ length: 9 }, (_, i) => ({
      t: 5.1 + i * 0.1, x: 10, y: 10, w: 20, h: 20,
      confidence: 1, visible: true, targetSim: 0.95,
    }));
    // Second low-sim run at t=6.0..7.0 (1.0s), NO anchor
    const secondRun = Array.from({ length: 11 }, (_, i) => ({
      t: 6.0 + i * 0.1, x: 10, y: 10, w: 20, h: 20,
      confidence: 1, visible: true, targetSim: 0.6,
    }));
    const samples = [...firstRun, ...highGap, ...secondRun];
    const t: Track = {
      id: "t", fileId: "f", method: "yoloe+botsort",
      framerate: 30, durationSec: 8,
      samples,
      // anchor at t=4.5 covers ONLY the first run
      agentAnchors: [{ id: "agt-4500", time: 4.5, bbox: [10, 10, 20, 20] }],
    };
    const s = summarizeTrack(t, opts);
    // covered-run branch must continue (not break) so the second run is also reached
    expect(s.flags).toContain("appearance_unverified_occlusion");
    expect(s.flags).toContain("identity_switch_suspected");
  });

  it("anchor exactly at the run end boundary ⇒ covered (occlusion, not switch)", () => {
    // Single 1.0s low-sim run: t=4.0..5.0 (11 samples matching lowRun())
    const run = lowRun(); // last sample t = 5.0
    const lastT = run[run.length - 1].t; // 5.0
    const t: Track = {
      id: "t", fileId: "f", method: "yoloe+botsort",
      framerate: 30, durationSec: 6,
      samples: run,
      // anchor exactly at run end — within ANCHOR_EPS=0.05 of r.end
      manualAnchors: [{ id: "man-end", time: lastT, bbox: [10, 10, 20, 20] }],
    };
    const s = summarizeTrack(t, opts);
    expect(s.flags).toContain("appearance_unverified_occlusion");
    expect(s.flags).not.toContain("identity_switch_suspected");
  });
});
