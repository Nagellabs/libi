/**
 * A tracked overlay must follow its video — in TIME and in SPACE.
 *
 * Track samples are timed in source-clip seconds and positioned in source
 * video pixels (`lib/tracking/types.ts`). The renderer used to sample at
 * GLOBAL composition time and hand the raw source box to `resolveTrackedRect`
 * as if it were composition coordinates. Both are only correct for a video
 * overlay that starts at 0, is untrimmed, and fills the frame 1:1.
 *
 * The two halves are tested together on purpose. Fixing the clock alone turns
 * "no HUD at all" into "a HUD in the wrong place at the wrong size", which is
 * the worse of the two failures.
 *
 * The onboarding film's slot D is the real-footage case: a 1920×1080 clip
 * mounted in a 1280×720 panel at (320,150) from 16 s, with the reticle
 * overlay windowed at 17.5–22.0 s over a track spanning 0–6 s clip time. The
 * expected boxes below are the hand-verified target frames in
 * docs-local/onboarding-v1/slot-d-frames/slotd-timespace-*.png.
 */
import { describe, it, expect, vi } from "vitest";
import {
  drawOverlay,
  applyFitAndScale,
  resolveTrackedRect,
  type DrawOverlayContext,
} from "@/lib/engine/overlay-renderer";
import {
  findTrackOwnerVideo,
  resolveTrackedSpace,
  trackedClipTime,
  sampleTrackedOverlay,
  trackBoxToComposition,
  compositionBoxToTrack,
  IDENTITY_TRACKED_SPACE,
} from "@/lib/engine/tracked-space";
import { sampleTrack } from "@/lib/tracking/sample";
import { ONBOARDING_PIECE_V1 } from "@/lib/onboarding/piece/v1";
import type { Overlay, TrackedOverlay, VideoOverlay } from "@/lib/engine/types";
import type { Track } from "@/lib/tracking/types";

const FRAME = { width: 1920, height: 1080 };

/** Composition-pixel tolerance against the hand-measured reference boxes,
 *  which were recorded rounded to whole pixels. */
function expectBox(
  actual: { x: number; y: number; w: number; h: number },
  expected: { x: number; y: number; w: number; h: number },
  tol = 1,
): void {
  for (const k of ["x", "y", "w", "h"] as const) {
    expect(Math.abs(actual[k] - expected[k]), `${k}: ${actual[k]} vs ${expected[k]}`)
      .toBeLessThanOrEqual(tol);
  }
}

// ── Synthetic composition: the brief's shape, round numbers ──────────────────

const SYNTH_TRACK: Track = {
  id: "trk",
  fileId: "file-clip",
  method: "manual",
  framerate: 30,
  durationSec: 6,
  samples: [
    { t: 0, x: 0, y: 0, w: 192, h: 108, confidence: 0.9, visible: true },
    { t: 6, x: 960, y: 540, w: 192, h: 108, confidence: 0.9, visible: true },
  ],
};

const PANEL_VIDEO: VideoOverlay = {
  id: "vid",
  kind: "video",
  startTime: 16,
  duration: 6,
  rect: { x: 320, y: 150, width: 1280, height: 720 },
  z: 4,
  opacity: 1,
  fileId: "file-clip",
  trim: { start: 0, end: 6 },
  fit: "cover",
  sourceWidth: 1920,
  sourceHeight: 1080,
};

const PANEL_TRACKED: TrackedOverlay = {
  id: "ov",
  kind: "tracked",
  startTime: 17.5,
  duration: 4.5,
  rect: { x: 320, y: 150, width: 1280, height: 720 },
  z: 6,
  opacity: 1,
  trackId: "trk",
  content: { kind: "image", fileId: "file-art" },
  fit: "tight",
  scale: 1,
  smoothing: "linear",
};

const FULL_FRAME_VIDEO: VideoOverlay = {
  ...PANEL_VIDEO,
  id: "vid-full",
  startTime: 0,
  rect: { x: 0, y: 0, width: 1920, height: 1080 },
  trim: undefined,
};

const FULL_FRAME_TRACKED: TrackedOverlay = {
  ...PANEL_TRACKED,
  id: "ov-full",
  startTime: 0,
  duration: 6,
  rect: { x: 0, y: 0, width: 1920, height: 1080 },
};

function mockCtx() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn((...args: unknown[]) => calls.push({ fn: "drawImage", args })),
    set globalAlpha(v: number) { (this as unknown as Record<string, unknown>)._a = v; },
    get globalAlpha() { return ((this as unknown as Record<string, unknown>)._a ?? 1) as number; },
    set filter(v: string) { (this as unknown as Record<string, unknown>)._f = v; },
    get filter() { return ((this as unknown as Record<string, unknown>)._f ?? "none") as string; },
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    fillStyle: "#000" as string,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

/** Draw a tracked IMAGE overlay and return the box `drawImage` landed on. */
function drawnBox(
  overlay: TrackedOverlay,
  overlays: Overlay[] | undefined,
  track: Track,
  globalTime: number,
): { x: number; y: number; w: number; h: number } | null {
  const { ctx, calls } = mockCtx();
  const img = { naturalWidth: 64, naturalHeight: 64 } as unknown as HTMLImageElement;
  drawOverlay(overlay, {
    ctx,
    width: FRAME.width,
    height: FRAME.height,
    fps: 30,
    totalFrames: 1560,
    frame: Math.round(globalTime * 30),
    time: globalTime,
    assets: {},
    tracks: { [overlay.trackId]: track },
    imageElements: { [overlay.id]: img },
    overlays,
  } as DrawOverlayContext);
  const call = calls.find((c) => c.fn === "drawImage");
  if (!call) return null;
  const [, x, y, w, h] = call.args as [unknown, number, number, number, number];
  return { x, y, w, h };
}

describe("tracked overlay: owning video", () => {
  it("derives the owner from the track's fileId", () => {
    const owner = findTrackOwnerVideo(SYNTH_TRACK, PANEL_TRACKED, [PANEL_VIDEO, PANEL_TRACKED]);
    expect(owner?.id).toBe("vid");
  });

  it("no video mounts the track's file → null, and the space is the identity", () => {
    const other: VideoOverlay = { ...PANEL_VIDEO, id: "other", fileId: "someone-else" };
    expect(findTrackOwnerVideo(SYNTH_TRACK, PANEL_TRACKED, [other])).toBeNull();
    expect(resolveTrackedSpace(PANEL_TRACKED, SYNTH_TRACK, [other])).toEqual(
      IDENTITY_TRACKED_SPACE,
    );
    expect(resolveTrackedSpace(PANEL_TRACKED, SYNTH_TRACK, undefined)).toEqual(
      IDENTITY_TRACKED_SPACE,
    );
  });

  it("two overlays of the same file → the one the tracked window sits in", () => {
    const first: VideoOverlay = { ...PANEL_VIDEO, id: "first", startTime: 0, duration: 3 };
    const second: VideoOverlay = { ...PANEL_VIDEO, id: "second", startTime: 16, duration: 6 };
    expect(findTrackOwnerVideo(SYNTH_TRACK, PANEL_TRACKED, [first, second])?.id).toBe("second");
    // …and the reverse for an overlay windowed on the first mount.
    const early = { ...PANEL_TRACKED, startTime: 0.5, duration: 2 };
    expect(findTrackOwnerVideo(SYNTH_TRACK, early, [first, second])?.id).toBe("first");
  });
});

describe("tracked overlay: timebase", () => {
  it("global time becomes the video's own clip clock", () => {
    const space = resolveTrackedSpace(PANEL_TRACKED, SYNTH_TRACK, [PANEL_VIDEO]);
    expect(trackedClipTime(space, 21.5)).toBeCloseTo(5.5, 10);
    expect(trackedClipTime(space, 17.5)).toBeCloseTo(1.5, 10);
  });

  it("a trimmed video shifts the clock by trim.start", () => {
    const trimmed: VideoOverlay = { ...PANEL_VIDEO, trim: { start: 2, end: 8 } };
    const space = resolveTrackedSpace(PANEL_TRACKED, SYNTH_TRACK, [trimmed]);
    expect(trackedClipTime(space, 21.5)).toBeCloseTo(7.5, 10);
  });

  it("the sampler is queried at clip time, not global time", () => {
    const s = sampleTrackedOverlay(PANEL_TRACKED, SYNTH_TRACK, [PANEL_VIDEO], 21.5);
    expect(s).not.toBeNull();
    expect(s!.t).toBeCloseTo(5.5, 10);
    // Sampling at global 21.5 is off the end of a 0–6 s track: null, which is
    // exactly why the overlay drew nothing before this fix.
    expect(sampleTrack(SYNTH_TRACK, 21.5, "linear")).toBeNull();
  });
});

describe("tracked overlay: coordinate space", () => {
  it("maps source pixels through the video's rect and fit", () => {
    const s = sampleTrackedOverlay(PANEL_TRACKED, SYNTH_TRACK, [PANEL_VIDEO], 21.5);
    // clip 5.5 → source box (880, 495, 192, 108); the 1920×1080 source covers
    // the 1280×720 panel at exactly 2/3, offset to the panel origin.
    expectBox(s!, { x: 320 + 880 * (2 / 3), y: 150 + 495 * (2 / 3), w: 128, h: 72 }, 1e-6);
  });

  it("the drawn box is the mapped box (renderer wiring)", () => {
    const box = drawnBox(PANEL_TRACKED, [PANEL_VIDEO, PANEL_TRACKED], SYNTH_TRACK, 21.5);
    expect(box).not.toBeNull();
    expectBox(box!, { x: 320 + 880 * (2 / 3), y: 150 + 495 * (2 / 3), w: 128, h: 72 }, 1e-6);
  });

  it("a 'contain' video letterboxes the track the same way it letterboxes the frame", () => {
    // A 1920×1080 source contained in a square 720×720 rect: pillar/letterbox
    // bars top and bottom, uniform 720/1920 scale.
    const square: VideoOverlay = {
      ...PANEL_VIDEO,
      rect: { x: 0, y: 180, width: 720, height: 720 },
      fit: "contain",
    };
    const space = resolveTrackedSpace(PANEL_TRACKED, SYNTH_TRACK, [square]);
    expect(space.scaleX).toBeCloseTo(720 / 1920, 6);
    // fitRect floors the bar offset — mirror it exactly, since this is the
    // same helper that positions the drawn frame.
    expect(space.offsetY).toBe(180 + Math.floor((720 - 405) / 2));
  });
});

describe("tracked overlay: the inverse the drag gestures need", () => {
  it("composition → source → composition round-trips", () => {
    const space = resolveTrackedSpace(PANEL_TRACKED, SYNTH_TRACK, [PANEL_VIDEO]);
    const src = { x: 807, y: 320, w: 807, h: 496 };
    const comp = trackBoxToComposition(space, src);
    expectBox(compositionBoxToTrack(space, comp), src, 1e-9);
  });

  it("is the identity for the identity space", () => {
    const box = { x: 12, y: 34, w: 56, h: 78 };
    expect(compositionBoxToTrack(IDENTITY_TRACKED_SPACE, box)).toEqual(box);
    expect(trackBoxToComposition(IDENTITY_TRACKED_SPACE, box)).toEqual(box);
  });
});

describe("tracked overlay: no regression for a full-frame video at t=0", () => {
  const overlays: Overlay[] = [FULL_FRAME_VIDEO, FULL_FRAME_TRACKED];

  it("the space is exactly the identity", () => {
    const space = resolveTrackedSpace(FULL_FRAME_TRACKED, SYNTH_TRACK, overlays);
    expect(space.scaleX).toBe(1);
    expect(space.scaleY).toBe(1);
    expect(space.offsetX).toBe(0);
    expect(space.offsetY).toBe(0);
    expect(space.timeOffset).toBe(0);
  });

  it("the drawn box equals the pre-fix computation, frame for frame", () => {
    for (const t of [0, 1.25, 3, 5.9]) {
      const legacySample = sampleTrack(SYNTH_TRACK, t, "linear")!;
      const legacy = applyFitAndScale(
        legacySample,
        FULL_FRAME_TRACKED.rect,
        FULL_FRAME_TRACKED.fit,
        FULL_FRAME_TRACKED.scale,
        FRAME,
      );
      expectBox(drawnBox(FULL_FRAME_TRACKED, overlays, SYNTH_TRACK, t)!, legacy, 1e-9);
    }
  });

  it("an unresolvable owner keeps the pre-fix behaviour rather than throwing", () => {
    // No overlay list at all (the shape every existing drawOverlay caller and
    // test uses): sample at global time in source coordinates.
    const legacySample = sampleTrack(SYNTH_TRACK, 3, "linear")!;
    const legacy = applyFitAndScale(
      legacySample,
      FULL_FRAME_TRACKED.rect,
      FULL_FRAME_TRACKED.fit,
      FULL_FRAME_TRACKED.scale,
      FRAME,
    );
    expectBox(drawnBox(FULL_FRAME_TRACKED, undefined, SYNTH_TRACK, 3)!, legacy, 1e-9);
  });
});

// ── The band between the identity and the panel ──────────────────────────────
//
// The no-regression case above pins ONE point: full-frame video, startTime 0,
// no trim, source dims == composition dims. The onboarding film pins the far
// end. Everything in between changed behaviour too, one axis at a time.

/** A track whose box never moves, so a mapping error can't hide behind
 *  interpolation. */
function staticTrack(box: { x: number; y: number; w: number; h: number }): Track {
  return {
    id: "trk",
    fileId: "file-clip",
    method: "manual",
    framerate: 30,
    durationSec: 6,
    samples: [
      { t: 0, ...box, confidence: 0.9, visible: true },
      { t: 6, ...box, confidence: 0.9, visible: true },
    ],
  };
}

describe("in between: a full-frame video that is TRIMMED", () => {
  // Only the clock moves. The existing trim test uses the windowed panel,
  // where the pixel map moves as well — so it cannot show that the clock
  // alone bites.
  const TRIMMED: VideoOverlay = {
    ...FULL_FRAME_VIDEO,
    id: "vid-trim",
    trim: { start: 2, end: 8 },
  };
  const overlays: Overlay[] = [TRIMMED, FULL_FRAME_TRACKED];

  it("shifts the clock by trim.start while the pixel map stays the identity", () => {
    const space = resolveTrackedSpace(FULL_FRAME_TRACKED, SYNTH_TRACK, overlays);
    expect(space.scaleX).toBe(1);
    expect(space.scaleY).toBe(1);
    expect(space.offsetX).toBe(0);
    expect(space.offsetY).toBe(0);
    // startTime 0, trim.start 2 ⇒ global 1.0 is clip 3.0.
    expect(trackedClipTime(space, 1.0)).toBeCloseTo(3.0, 10);
  });

  it("draws the box the clip's own clock says, not the global one", () => {
    // Clip 3.0 of SYNTH_TRACK is the midpoint: (480, 270, 192, 108).
    expectBox(drawnBox(FULL_FRAME_TRACKED, overlays, SYNTH_TRACK, 1.0)!, {
      x: 480,
      y: 270,
      w: 192,
      h: 108,
    }, 1e-9);
    // …and that is genuinely different from the untrimmed mount at the same
    // global time, which reads clip 1.0.
    expectBox(
      drawnBox(FULL_FRAME_TRACKED, [FULL_FRAME_VIDEO, FULL_FRAME_TRACKED], SYNTH_TRACK, 1.0)!,
      { x: 160, y: 90, w: 192, h: 108 },
      1e-9,
    );
  });
});

describe("in between: a full-frame video whose SOURCE is smaller than the composition", () => {
  // 1280×720 source filling a 1920×1080 frame — no window, no trim, nothing
  // but the scale. Before the fix a source-pixel box was drawn as if it were
  // composition pixels, so the art sat at 2/3 size, up and to the left.
  const SD_VIDEO: VideoOverlay = {
    ...FULL_FRAME_VIDEO,
    id: "vid-sd",
    sourceWidth: 1280,
    sourceHeight: 720,
  };
  const track = staticTrack({ x: 300, y: 150, w: 100, h: 100 });
  const overlays: Overlay[] = [SD_VIDEO, FULL_FRAME_TRACKED];

  it("scales boxes by the cover fit, uniformly and with no offset", () => {
    const space = resolveTrackedSpace(FULL_FRAME_TRACKED, track, overlays);
    expect(space.scaleX).toBeCloseTo(1.5, 12);
    expect(space.scaleY).toBeCloseTo(1.5, 12);
    expect(space.offsetX).toBe(0);
    expect(space.offsetY).toBe(0);
  });

  it("(300,150,100,100) in source pixels is (450,225,150,150) in the composition", () => {
    const sample = sampleTrackedOverlay(FULL_FRAME_TRACKED, track, overlays, 3);
    expectBox(sample!, { x: 450, y: 225, w: 150, h: 150 }, 1e-9);
    expectBox(drawnBox(FULL_FRAME_TRACKED, overlays, track, 3)!, {
      x: 450,
      y: 225,
      w: 150,
      h: 150,
    }, 1e-9);
  });
});

describe("in between: fit 'head' now judges a COMPOSITION box against the frame", () => {
  // `applyFitAndScale`'s person-vs-face heuristic (`w*h >= 0.1 * frame area`)
  // and `clampToFrame` (`0.66 * frame dimension`) both compare their box
  // against the COMPOSITION's dimensions. They were being handed a box in
  // SOURCE pixels — a category error, which routing the sample through
  // `tracked-space` fixes. It changes fit:"head" output for every non-identity
  // video, so pin it deliberately rather than leave it incidental.
  const SD_VIDEO: VideoOverlay = {
    ...FULL_FRAME_VIDEO,
    id: "vid-sd-head",
    sourceWidth: 1280,
    sourceHeight: 720,
  };
  const HEAD_TRACKED: TrackedOverlay = { ...FULL_FRAME_TRACKED, id: "ov-head", fit: "head" };
  // Square-ish, deliberately straddling the threshold: 380×380 = 144 400 px²
  // in source space is under 0.1·1920·1080 = 207 360; the same box scaled 1.5×
  // is 570×570 = 324 900 px², over it.
  const track = staticTrack({ x: 300, y: 150, w: 380, h: 380 });
  const overlays: Overlay[] = [SD_VIDEO, HEAD_TRACKED];

  it("the source box reads as a FACE and the composition box as a BODY", () => {
    const raw = sampleTrack(track, 3, "linear")!;
    // Pre-fix: 380×380 is under the "big" threshold ⇒ face branch ⇒ extended
    // upward by 50 %, straight off the top of the frame.
    expectBox(applyFitAndScale(raw, HEAD_TRACKED.rect, "head", 1, FRAME), {
      x: 300,
      y: -40,
      w: 380,
      h: 570,
    }, 1e-9);

    // Post-fix: the box handed to the same helper is 570×570, which is "big"
    // and at least as tall as wide ⇒ person-like ⇒ isolate a head-sized square
    // at the top-centre: side = min(0.22·570, 0.9·570) = 125.4.
    const sample = sampleTrackedOverlay(HEAD_TRACKED, track, overlays, 3);
    expectBox(sample!, { x: 450, y: 225, w: 570, h: 570 }, 1e-9);
    expectBox(resolveTrackedRect(sample!, HEAD_TRACKED, FRAME), {
      x: 672.3,
      y: 231.27,
      w: 125.4,
      h: 125.4,
    }, 1e-9);
  });

  it("and the renderer draws that box", () => {
    expectBox(drawnBox(HEAD_TRACKED, overlays, track, 3)!, {
      x: 672.3,
      y: 231.27,
      w: 125.4,
      h: 125.4,
    }, 1e-9);
  });
});

describe("a missing owner is warned about, once", () => {
  it("says so rather than silently drawing nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const orphan: Track = { ...SYNTH_TRACK, fileId: "file-nobody-mounts" };
      // A list IS supplied and contains no mount for the track's file — the
      // case that, on a windowed clip, draws nothing at all.
      resolveTrackedSpace(PANEL_TRACKED, orphan, [PANEL_VIDEO, PANEL_TRACKED]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("file-nobody-mounts");
      // Per frame at 30fps: exactly once, not once per frame.
      resolveTrackedSpace(PANEL_TRACKED, orphan, [PANEL_VIDEO, PANEL_TRACKED]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet for the legacy no-overlay-list call shape", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      resolveTrackedSpace(PANEL_TRACKED, SYNTH_TRACK, undefined);
      resolveTrackedSpace(PANEL_TRACKED, SYNTH_TRACK, []);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("IDENTITY_TRACKED_SPACE is frozen", () => {
  it("cannot be mutated by a careless consumer", () => {
    // It is exported AND returned by reference from every fallback path.
    expect(Object.isFrozen(IDENTITY_TRACKED_SPACE)).toBe(true);
  });
});

// ── The real film ───────────────────────────────────────────────────────────

/**
 * Slot D of the onboarding film, as the FILM used to ship it.
 *
 * The video overlay is read live out of the definition — the clip, the panel
 * rect, the 16 s start and the untrimmed window are all still there, and if
 * the film is recut this fixture moves with it.
 *
 * The tracked overlay and its track are stated here rather than read, because
 * the shipped demo no longer carries either: slot D's reticle is now a plain
 * code overlay with its boxes baked in, so a brand-new user is not shown a
 * feature whose model libi has not provisioned yet
 * (`OnboardingPieceDefinition`). NONE OF THAT IS A CLAIM ABOUT THE ENGINE.
 * The conversion this file tests is what every user's own tracked overlay over
 * a windowed or trimmed clip depends on, it is unchanged, and the numbers
 * below are the real ones: the four samples are copied at full precision from
 * the track the film was built with, and the overlay's fields are the ones the
 * `tracked` overlay carried.
 */
const SLOT_D_TRACK: Track = {
  id: "trk-slot-d",
  fileId: "clip-track-demo.mp4",
  method: "yoloe+botsort",
  framerate: 30,
  durationSec: 6,
  samples: [
    { t: 1, x: 439.8753486256792, y: 243.8684247125782, w: 1142.9542724094417, h: 550.5350256965569, confidence: 0.9, visible: true },
    { t: 2.5, x: 541.1568083567142, y: 264.9290305417261, w: 1033.5618886855113, h: 537.7605259856616, confidence: 0.9, visible: true },
    { t: 4, x: 660.714220671822, y: 292.9423377645254, w: 957.4235554132656, h: 513.6516434780158, confidence: 0.9, visible: true },
    { t: 5.5, x: 807.4247146911006, y: 319.6799068193503, w: 807.37262953089, h: 496.020485836332, confidence: 0.9, visible: true },
  ],
};

function onboardingSlotD(): { overlays: Overlay[]; tracked: TrackedOverlay; track: Track } {
  // The definition names media by slug; the runtime names it by fileId.
  // Slug-as-fileId is faithful enough for placement math.
  const overlays = ONBOARDING_PIECE_V1.overlays.map((o) => {
    if (o.kind !== "video") return o as unknown as Overlay;
    const v = o as unknown as { assetSlug: string };
    return {
      ...o,
      fileId: v.assetSlug,
      // Real probe of docs-local/onboarding-v1/assets/clip-track-demo.mp4.
      sourceWidth: v.assetSlug === "clip-track-demo.mp4" ? 1920 : null,
      sourceHeight: v.assetSlug === "clip-track-demo.mp4" ? 1080 : null,
    } as unknown as Overlay;
  });
  const tracked: TrackedOverlay = {
    id: "tracked-c5da91a2",
    kind: "tracked",
    startTime: 17.5,
    duration: 4.5,
    rect: { x: 320, y: 150, width: 1280, height: 720 },
    z: 6,
    opacity: 1,
    trackId: SLOT_D_TRACK.id,
    content: { kind: "emoji", char: "◎" },
    fit: "tight",
    scale: 1.15,
    smoothing: "linear",
  } as unknown as TrackedOverlay;
  return { overlays: [...overlays, tracked as unknown as Overlay], tracked, track: SLOT_D_TRACK };
}

describe("onboarding slot D reticle", () => {
  const { overlays, tracked, track } = onboardingSlotD();

  it("the track and the overlay live on different clocks", () => {
    expect(track.samples.at(-1)!.t).toBeLessThan(tracked.startTime);
  });

  // docs-local/onboarding-v1/slot-d-frames/MEASUREMENTS.txt — the TIME+SPACE
  // column, i.e. the boxes in slotd-timespace-*.png.
  const TARGETS: Array<[number, { x: number; y: number; w: number; h: number }]> = [
    [17.0, { x: 556, y: 285, w: 876, h: 422 }],
    [18.5, { x: 629, y: 300, w: 792, h: 412 }],
    [20.0, { x: 713, y: 320, w: 734, h: 394 }],
    [21.5, { x: 818, y: 338, w: 619, h: 380 }],
  ];

  for (const [globalTime, expected] of TARGETS) {
    it(`lands on the sneaker at ${globalTime}s`, () => {
      const sample = sampleTrackedOverlay(tracked, track, overlays, globalTime);
      expect(sample, "no sample — the overlay would draw nothing").not.toBeNull();
      expect(sample!.visible).toBe(true);
      expectBox(resolveTrackedRect(sample!, tracked, FRAME), expected);
    });
  }

  it("draws nothing before its window opens, as the video's own clock runs out", () => {
    // 22.5 s is past the tracked window AND past the clip; the sampler must
    // return null rather than clamp to the last box.
    expect(sampleTrackedOverlay(tracked, track, overlays, 22.5)).toBeNull();
  });
});
