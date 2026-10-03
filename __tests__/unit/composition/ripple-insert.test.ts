/**
 * Ripple INSERT: the inverse of rippleCloseGap (lib/composition/ripple-insert.ts holds the rules).
 *
 * Timeline (the Dreams shape): intro video INTRO 0-5 (file 8 s long, trimmed 0-5) with its inline audio,
 * full-length code layers BG 0-20 and a bed MUSIC 0-20 (ducked by NARR), narration NARR 5.3-12, caption CAP
 * 5.3-12 (words element-local), a sticker STICK 3-8 that merely straddles 5, an end card END 15-20.
 */
import { describe, expect, it } from "vitest";
import { rippleInsertTime, type InsertTimeOptions } from "@/lib/composition/ripple-insert";
import { pieceDurationSec } from "@/lib/composition/duration";
import type { CompositionManifest, PersistedAudioClip, PersistedOverlay } from "@/lib/composition/persistence";

const rect = { x: 0, y: 0, width: 1080, height: 1920 };
const text = (id: string, startTime: number, duration: number, extra: Record<string, unknown> = {}): PersistedOverlay =>
  ({
    id, kind: "text", startTime, duration, z: 1, opacity: 1, rect, content: id, font: "sans-serif", color: "#fff", align: "center",
    ...extra,
  }) as PersistedOverlay;

function manifest(): CompositionManifest {
  const overlays: PersistedOverlay[] = [
    { id: "BG", kind: "code", startTime: 0, duration: 20, z: 0, opacity: 1, rect, drawFunction: "", keyframes: { opacity: { keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] } } } as PersistedOverlay,
    { id: "INTRO", kind: "video", fileId: "vf", startTime: 0, duration: 5, z: 1, opacity: 1, rect, trim: { start: 0, end: 5 } } as PersistedOverlay,
    text("STICK", 3, 5, { z: 2 }),
    text("CAP", 5.3, 6.7, {
      z: 3,
      caption: { groupId: "g", useTrackStyle: true, words: [{ text: "hi", start: 0.2, end: 0.6 }] },
      keyframes: { opacity: { keyframes: [{ t: 0.1, value: 0 }, { t: 0.2, value: 1 }] } },
    }),
    { id: "END", kind: "code", startTime: 15, duration: 5, z: 4, opacity: 1, rect, drawFunction: "" } as PersistedOverlay,
  ];
  const clip = (c: Partial<PersistedAudioClip> & { id: string }): PersistedAudioClip => ({
    kind: "standalone", fileId: "af", startTime: 0, duration: 1, trimStart: 0, volume: 1, enabled: true, ...c,
  });
  const audioClips: PersistedAudioClip[] = [
    clip({ id: "aINTRO", kind: "inline", fileId: "vf", linkedOverlayId: "INTRO", startTime: 0, duration: 5, volumeKeyframes: { keyframes: [{ t: 0, value: 0 }, { t: 4.9, value: -6 }] } }),
    clip({
      id: "MUSIC", fileId: "mf", startTime: 0, duration: 20, volume: 0.5,
      volumeKeyframes: { keyframes: [{ t: 0, value: 0 }, { t: 4, value: 0 }, { t: 5.3, value: -12 }, { t: 12, value: -12 }, { t: 13, value: 0 }] },
      duck: { sidechainClipIds: ["NARR"], thresholdDb: -30, ratio: 4, attackMs: 10, releaseMs: 200, reductionDb: 10 },
    }),
    clip({ id: "NARR", fileId: "nf", startTime: 5.3, duration: 6.7, volumeKeyframes: { keyframes: [{ t: 0, value: -3 }, { t: 2, value: 0 }] } }),
  ];
  return { width: 1080, height: 1920, fps: 30, overlays, audioClips };
}

const FILES: Record<string, number> = { vf: 8, mf: 60, nf: 6.7, af: 100 };
const run = (m: CompositionManifest, o: Partial<InsertTimeOptions> = {}) =>
  rippleInsertTime(m, { at: 5, seconds: 3, mediaDuration: (id) => FILES[id], ...o });
const ok = (r: ReturnType<typeof run>) => {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r;
};
const ov = (m: CompositionManifest, id: string) => (m.overlays ?? []).find((o) => o.id === id)!;
const clipOf = (m: CompositionManifest, id: string) => (m.audioClips ?? []).find((c) => c.id === id)!;

describe("rippleInsertTime: shift", () => {
  it("moves everything that starts at or after `at` right, and nothing before it", () => {
    const { manifest: out, report } = ok(run(manifest(), { stretch: "none" }));
    expect(ov(out, "CAP").startTime).toBeCloseTo(8.3);
    expect(ov(out, "END").startTime).toBe(18);
    expect(clipOf(out, "NARR").startTime).toBeCloseTo(8.3);
    expect(ov(out, "INTRO").startTime).toBe(0);
    expect(ov(out, "STICK").startTime).toBe(3);
    expect(report.shifted.sort()).toEqual(["CAP", "END", "NARR"]);
  });

  it("an item starting exactly at `at` shifts (the ripple-close rule, inverted)", () => {
    const m = manifest();
    m.overlays!.push(text("EXACT", 5, 1));
    const { manifest: out } = ok(run(m));
    expect(ov(out, "EXACT").startTime).toBe(8);
  });

  it("keeps overlay keyframes (normalised) and caption words (overlay-local) as they were", () => {
    const m = manifest();
    const { manifest: out } = ok(run(m));
    expect(ov(out, "CAP")).toMatchObject({
      keyframes: m.overlays!.find((o) => o.id === "CAP")!.keyframes,
      caption: { words: [{ text: "hi", start: 0.2, end: 0.6 }] },
      duration: 6.7,
    });
  });

  it("a shifted clip keeps its volume envelope and its duck, and the duck still points at the moved narration", () => {
    const m = manifest();
    const { manifest: out } = ok(run(m));
    expect(clipOf(out, "NARR").volumeKeyframes).toEqual(clipOf(m, "NARR").volumeKeyframes);
    expect(clipOf(out, "MUSIC").duck?.sidechainClipIds).toEqual(["NARR"]);
  });

  it("leaves the piece unchanged and says so when nothing is at or after `at`", () => {
    const m = manifest();
    const { manifest: out, report } = ok(run(m, { at: 50 }));
    expect(out).toEqual(m);
    expect(report.shifted).toEqual([]);
    expect(report.pieceDuration).toEqual({ before: 20, after: 20 });
  });
});

describe("rippleInsertTime: stretch", () => {
  it("by default stretches the full-length layers that span `at`, and leaves a straddling sticker", () => {
    const { manifest: out, report } = ok(run(manifest()));
    expect(ov(out, "BG").duration).toBe(23);
    expect(clipOf(out, "MUSIC").duration).toBe(23);
    expect(ov(out, "STICK").duration).toBe(5);
    expect(report.stretched.sort()).toEqual(["BG", "MUSIC"]);
    expect(report.leftSpanning).toEqual(["STICK"]);
    expect(report.pieceDuration).toEqual({ before: 20, after: 23 });
  });

  it("a stretched layer keeps its keyframes relative (normalised times untouched)", () => {
    const m = manifest();
    const { manifest: out } = ok(run(m));
    expect((ov(out, "BG") as { keyframes: unknown }).keyframes).toEqual((ov(m, "BG") as { keyframes: unknown }).keyframes);
  });

  it("a stretched clip moves the envelope keys at or after `at`, not the ones before it", () => {
    const { manifest: out } = ok(run(manifest()));
    // keys at 0, 4 stay; 5.3, 12, 13 are at/after 5 and move by 3
    expect(clipOf(out, "MUSIC").volumeKeyframes!.keyframes.map((k) => k.t)).toEqual([0, 4, 8.3, 15, 16]);
    expect(clipOf(out, "MUSIC").volumeKeyframes!.keyframes.map((k) => k.value)).toEqual([0, 0, -12, -12, 0]);
  });

  it('"spanning" stretches every layer that spans `at`', () => {
    const { manifest: out, report } = ok(run(manifest(), { stretch: "spanning" }));
    expect(ov(out, "STICK").duration).toBe(8);
    expect(report.leftSpanning).toEqual([]);
  });

  it('"none" stretches nothing, so the background ends early', () => {
    const { manifest: out, report } = ok(run(manifest(), { stretch: "none" }));
    expect(ov(out, "BG").duration).toBe(20);
    expect(report.stretched).toEqual([]);
    expect(report.leftSpanning.sort()).toEqual(["BG", "MUSIC", "STICK"]);
  });

  it("an explicit list stretches exactly those ids", () => {
    const { manifest: out } = ok(run(manifest(), { stretch: ["STICK"] }));
    expect(ov(out, "STICK").duration).toBe(8);
    expect(ov(out, "BG").duration).toBe(20);
    expect(clipOf(out, "MUSIC").duration).toBe(20);
  });

  it("refuses an unknown id, and an id that ends before `at`, naming extendTarget", () => {
    const a = run(manifest(), { stretch: ["nope"] });
    expect(a).toMatchObject({ ok: false, error: "stretch_id_not_found" });
    const b = run(manifest(), { stretch: ["INTRO"] });
    expect(b).toMatchObject({ ok: false, error: "stretch_id_not_spanning" });
    expect((b as { message: string }).message).toContain("extendTarget");
  });

  it("caps a bed at what its file has and warns, keeping the envelope keys moving", () => {
    const { manifest: out, report } = ok(run(manifest(), { mediaDuration: (id) => (id === "mf" ? 21 : FILES[id]) }));
    expect(clipOf(out, "MUSIC").duration).toBe(21);
    expect(report.warnings.join(" ")).toContain("MUSIC");
    expect(clipOf(out, "MUSIC").volumeKeyframes!.keyframes.map((k) => k.t)).toEqual([0, 4, 8.3, 15, 16]);
  });

  it("a coupled video in the stretch list is stretched through its inline clip too", () => {
    const m = manifest();
    m.overlays!.push({ id: "BGV", kind: "video", fileId: "vf", startTime: 0, duration: 6, z: 9, opacity: 1, rect, trim: { start: 0, end: 6 } } as PersistedOverlay);
    m.audioClips!.push({ id: "aBGV", kind: "inline", fileId: "vf", linkedOverlayId: "BGV", startTime: 0, duration: 6, trimStart: 0, volume: 1, enabled: true });
    const { manifest: out } = ok(run(m, { stretch: ["BGV"], mediaDuration: () => 30 }));
    expect(ov(out, "BGV")).toMatchObject({ duration: 9, trim: { start: 0, end: 9 } });
    expect(clipOf(out, "aBGV").duration).toBe(9);
  });
});

describe("rippleInsertTime: extendTarget", () => {
  it("lengthens the intro, extends its trim and its inline audio, and shifts the rest", () => {
    const m = manifest();
    const { manifest: out, report } = ok(run(m, { extendTarget: "INTRO" }));
    expect(ov(out, "INTRO")).toMatchObject({ startTime: 0, duration: 8, trim: { start: 0, end: 8 } });
    expect(clipOf(out, "aINTRO")).toMatchObject({ startTime: 0, duration: 8, trimStart: 0 });
    expect(clipOf(out, "NARR").startTime).toBeCloseTo(8.3);
    expect(report.extended).toEqual([{ id: "INTRO", duration: [5, 8], trim: [[0, 5], [0, 8]] }]);
    expect(report.stretched).not.toContain("INTRO");
    // the full-length layers still cover the piece
    expect(ov(out, "BG").duration).toBe(23);
  });

  it("the inline clip's envelope keys at or after `at` move with the insert; earlier ones stay", () => {
    const { manifest: out } = ok(run(manifest(), { extendTarget: "INTRO", at: 4.95 }));
    // key at 4.9 is before 4.95 and stays
    expect(clipOf(out, "aINTRO").volumeKeyframes!.keyframes.map((k) => k.t)).toEqual([0, 4.9]);
    const late = ok(run(manifest(), { extendTarget: "INTRO", at: 4.9 }));
    expect(clipOf(late.manifest, "aINTRO").volumeKeyframes!.keyframes.map((k) => k.t)).toEqual([0, 7.9]);
  });

  it("refuses, naming the footage left, when the source has no room", () => {
    const r = run(manifest(), { extendTarget: "INTRO", seconds: 4, mediaDuration: (id) => (id === "vf" ? 8 : FILES[id]) });
    expect(r).toMatchObject({ ok: false, error: "no_source_room" });
    expect((r as { message: string }).message).toMatch(/only 3 s of footage is left/);
    // …and succeeds at the largest amount that fits
    expect(run(manifest(), { extendTarget: "INTRO", seconds: 3, mediaDuration: () => 8 }).ok).toBe(true);
  });

  it("an extend target with an unknown source length is lengthened, with a warning", () => {
    const { manifest: out, report } = ok(run(manifest(), { extendTarget: "INTRO", mediaDuration: () => null }));
    expect(ov(out, "INTRO").duration).toBe(8);
    expect(report.warnings.join(" ")).toContain("source length is unknown");
  });

  it("extends a non-video overlay with no source check", () => {
    const m = manifest();
    m.overlays!.push(text("TITLE", 0, 5, { z: 7 }));
    const { manifest: out } = ok(run(m, { extendTarget: "TITLE" }));
    expect(ov(out, "TITLE").duration).toBe(8);
  });

  it("refuses an unknown target, an audio clip, and one that does not end at `at`", () => {
    expect(run(manifest(), { extendTarget: "zzz" })).toMatchObject({ ok: false, error: "extend_target_not_found" });
    expect(run(manifest(), { extendTarget: "NARR" })).toMatchObject({ ok: false, error: "extend_target_not_overlay" });
    const early = run(manifest(), { extendTarget: "INTRO", at: 9 });
    expect(early).toMatchObject({ ok: false, error: "extend_target_not_at_end" });
    expect((early as { message: string }).message).toContain("Set `at` to its end (5)");
    expect(run(manifest(), { extendTarget: "CAP" })).toMatchObject({ ok: false, error: "extend_target_not_at_end" });
  });

  it("a refusal changes nothing", () => {
    const m = manifest();
    const before = structuredClone(m);
    run(m, { extendTarget: "INTRO", seconds: 9 });
    expect(m).toEqual(before);
  });
});

describe("rippleInsertTime: inline audio", () => {
  it("an inline clip follows a shifted video", () => {
    const m = manifest();
    m.overlays!.push({ id: "V2", kind: "video", fileId: "vf", startTime: 12, duration: 3, z: 8, opacity: 1, rect } as PersistedOverlay);
    m.audioClips!.push({ id: "aV2", kind: "inline", fileId: "vf", linkedOverlayId: "V2", startTime: 12, duration: 3, trimStart: 0, volume: 1, enabled: true });
    const { manifest: out } = ok(run(m));
    expect(ov(out, "V2").startTime).toBe(15);
    expect(clipOf(out, "aV2").startTime).toBe(15);
  });

  it("a detached clip (standalone, linked) is an ordinary clip", () => {
    const m = manifest();
    m.audioClips!.push({ id: "DET", kind: "standalone", fileId: "vf", linkedOverlayId: "INTRO", startTime: 6, duration: 2, trimStart: 0, volume: 1, enabled: true });
    const { manifest: out } = ok(run(m));
    expect(clipOf(out, "DET").startTime).toBe(9);
  });
});

describe("rippleInsertTime: crossfades and arguments", () => {
  it("warns when a shifted clip loses the overlap its crossfade needs", () => {
    const m = manifest();
    // A (left spanning) overlaps B (shifted) on the same file.
    m.audioClips!.push(
      { id: "A", kind: "standalone", fileId: "xf", startTime: 2, duration: 6, trimStart: 0, volume: 1, enabled: true },
      { id: "B", kind: "standalone", fileId: "xf", startTime: 7, duration: 3, trimStart: 6, volume: 1, enabled: true, crossfadeMs: 500 },
    );
    const r = ok(run(m, { at: 6, stretch: "none" }));
    expect(r.report.warnings.join(" ")).toMatch(/B: its crossfade no longer overlaps/);
  });

  it("refuses non-positive seconds and a negative `at`", () => {
    expect(run(manifest(), { seconds: 0 })).toMatchObject({ ok: false, error: "invalid_seconds" });
    expect(run(manifest(), { seconds: -2 })).toMatchObject({ ok: false, error: "invalid_seconds" });
    expect(run(manifest(), { at: -1 })).toMatchObject({ ok: false, error: "invalid_at" });
  });

  it("piece duration grows by exactly `seconds` when the last item shifts", () => {
    const m = manifest();
    const { manifest: out } = ok(run(m));
    expect(pieceDurationSec(out)).toBe(pieceDurationSec(m) + 3);
  });
});
