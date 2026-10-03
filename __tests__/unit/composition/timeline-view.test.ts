import { describe, it, expect } from "vitest";
import { renderTimeline, sec, type TimelinePieceInput } from "@/lib/composition/timeline-view";
import type { CompositionManifest } from "@/lib/composition/persistence";

const rect = { x: 0, y: 0, width: 1080, height: 1920 };

function piece(id: string, name: string, over: Partial<CompositionManifest> = {}, hasDraft = true): TimelinePieceInput {
  const manifest = {
    width: 1080,
    height: 1920,
    fps: 30,
    overlays: [
      { id: `${id}-v`, kind: "video", fileId: `${id}-fv`, startTime: 0, duration: 12.4, z: 0, opacity: 1, rect },
      { id: `${id}-t`, kind: "text", content: "Hello world", font: "20px Inter", color: "#fff", align: "center", startTime: 1, duration: 3, z: 2, opacity: 1, rect, effects: { in: { effectId: "fade" } } },
      { id: `${id}-c`, kind: "code", displayName: "End card", startTime: 9.5, duration: 2.9, z: 3, opacity: 1, rect },
    ],
    audioClips: [
      { id: `${id}-a1`, kind: "inline", linkedOverlayId: `${id}-v`, fileId: `${id}-fv`, startTime: 0, duration: 12.4, trimStart: 0, volume: 1, enabled: true },
      {
        id: `${id}-a2`, kind: "standalone", fileId: `${id}-fm`, startTime: 0, duration: 12.4, trimStart: 0, volume: 0.35, enabled: true,
        duck: { sidechainClipIds: [`${id}-a1`], thresholdDb: -24, ratio: 4, attackMs: 10, releaseMs: 200, reductionDb: -12 },
      },
    ],
    ...over,
  } as unknown as CompositionManifest;
  return {
    pieceId: id,
    name,
    manifest,
    hasDraft,
    files: new Map([
      [`${id}-fv`, { name: "clip.mp4", rights: { class: "owned" } }],
      [`${id}-fm`, { name: "bed.mp3", rights: { class: "copyrighted", track: "Dreams" } }],
    ]),
  };
}

describe("sec", () => {
  it("prints at most two decimals and no trailing zeros", () => {
    expect([sec(0), sec(1.5), sec(12.344), sec(3), sec(-0.001)]).toEqual(["0", "1.5", "12.34", "3", "0"]);
  });
});

describe("renderTimeline, one piece", () => {
  const text = renderTimeline([piece("p1", "Dreams 01")]);
  const lines = text.split("\n");

  it("headlines the piece: name, id, duration, size, fps, draft, counts", () => {
    expect(lines[0]).toBe("piece Dreams 01 [p1] 12.4s 1080x1920 30fps draft, 3 overlays, 2 audio");
  });

  it("prints one line per overlay, top layer first: id kind start–end z name [flags]", () => {
    const i = lines.indexOf("overlays (top layer first):");
    expect(lines.slice(i + 1, i + 4)).toEqual([
      "  p1-c code 9.5–12.4 z3 End card",
      "  p1-t text 1–4 z2 Hello world fx:in=fade",
      "  p1-v video 0–12.4 z0 clip.mp4 audio:p1-a1",
    ]);
  });

  it("prints one line per audio clip: file, span, volume, duck sidechains, link, rights", () => {
    const i = lines.indexOf("audio:");
    expect(lines.slice(i + 1, i + 3)).toEqual([
      "  p1-a1 clip.mp4 0–12.4 vol1 link:p1-v owned",
      "  p1-a2 bed.mp3 0–12.4 vol0.35 duck(p1-a1 -12dB) copyrighted(Dreams)",
    ]);
  });

  it("prints the source file's length and the footage left after the trim end, for videos and audio clips", () => {
    const p = piece("p1", "x");
    p.files = new Map([
      ["p1-fv", { name: "clip.mp4", duration: 16, rights: { class: "owned" } }],
      ["p1-fm", { name: "bed.mp3", duration: 30, rights: { class: "copyrighted", track: "Dreams" } }],
    ]);
    const m = p.manifest as unknown as { overlays: Record<string, unknown>[]; audioClips: Record<string, unknown>[] };
    m.overlays[0].trim = { start: 2, end: 14.4 };
    m.audioClips[1].trimStart = 5;
    const t = renderTimeline([p]);
    expect(t).toContain("  p1-v video 0–12.4 z0 clip.mp4 src 16s, 1.6s left audio:p1-a1");
    expect(t).toContain("  p1-a2 bed.mp3 0–12.4 src 30s, 12.6s left vol0.35");
    // a layer that already runs past its file has nothing left, never a negative number
    m.overlays[0].duration = 20;
    expect(renderTimeline([p])).toContain("src 16s, 0s left");
    // only video overlays carry it; text and code layers do not
    expect(t).not.toMatch(/p1-t .*src/);
    expect(t).not.toMatch(/p1-c .*src/);
  });

  it("omits it when the file's length was never probed", () => {
    expect(renderTimeline([piece("p1", "x")])).not.toContain("src ");
  });

  it("compares it across pieces: a longer source file in another piece is a difference", () => {
    const a = piece("a", "A");
    const b = piece("b", "B");
    a.files = new Map([...a.files, ["a-fv", { name: "clip.mp4", duration: 16 }]]);
    b.files = new Map([...b.files, ["b-fv", { name: "clip.mp4", duration: 20 }]]);
    expect(renderTimeline([a, b])).toMatch(/b-v video .* src 20s, 7\.6s left .*≠src/);
  });

  it("is a fraction of the manifest's size", () => {
    expect(text.length).toBeLessThan(JSON.stringify(piece("p1", "x").manifest).length / 2);
  });

  it("shows gain, fades, a muted clip, a hidden or keyframed overlay when they are set", () => {
    const p = piece("p1", "x");
    const m = p.manifest as unknown as { overlays: Record<string, unknown>[]; audioClips: Record<string, unknown>[] };
    m.overlays[1].hidden = true;
    m.overlays[1].keyframes = { opacity: { keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] } };
    m.audioClips[1].gainDb = 3.8;
    m.audioClips[1].enabled = false;
    m.audioClips[1].effects = { out: { effectId: "audio-fade-out" } };
    const t = renderTimeline([p]);
    expect(t).toContain("hidden fx:in=fade kf:opacity");
    expect(t).toContain("vol0.35 off gain+3.8dB duck(p1-a1 -12dB) fade:out=audio-fade-out");
  });

  it("prints a volume envelope and a crossfade compactly, six keys at most", () => {
    const p = piece("p1", "x");
    const m = p.manifest as unknown as { audioClips: Record<string, unknown>[] };
    m.audioClips[1].gainDb = 4;
    m.audioClips[1].crossfadeMs = 80;
    m.audioClips[1].volumeKeyframes = { keyframes: [{ t: 5, value: 0 }, { t: 7, value: -12 }, { t: 12, value: -12 }, { t: 14, value: 0 }] };
    expect(renderTimeline([p])).toContain("gain+4dB env[5s:0 7s:-12 12s:-12 14s:0]dB xfade80ms");
    m.audioClips[1].volumeKeyframes = { keyframes: Array.from({ length: 9 }, (_, i) => ({ t: i, value: -i })) };
    expect(renderTimeline([p])).toContain("env[0s:0 1s:-1 2s:-2 3s:-3 4s:-4 5s:-5 +3]dB");
  });

  it("has no overlays/audio sections for an empty piece", () => {
    const t = renderTimeline([piece("p1", "Empty", { overlays: [], audioClips: [] }, false)]);
    expect(t).toBe("piece Empty [p1] 0s 1080x1920 30fps no draft, 0 overlays, 0 audio");
  });
});

/** Everything below the one-line summary, which itself explains the `≠` mark. */
const body = (t: string) => t.split("\n").slice(1).join("\n");

describe("renderTimeline, several pieces", () => {
  it("says at once that identical pieces are the same, marking every later layer `=`", () => {
    const t = renderTimeline([piece("a", "A"), piece("b", "B"), piece("c", "C")]);
    expect(t.split("\n")[0]).toMatch(/^3 pieces\. All match the first piece \(ids aside\)\./);
    expect(t).toContain("  b-c =");
    expect(t).toContain("  b-a2 =");
    // the ids differ per piece and are never what makes a line differ
    expect(body(t)).not.toContain("≠");
  });

  it("marks the lines that differ and names the fields, and lists the pieces that differ", () => {
    const b = piece("b", "B");
    const bm = b.manifest as unknown as { overlays: { id: string; duration: number }[]; audioClips: { id: string; volume: number }[] };
    bm.overlays.find((o) => o.id === "b-c")!.duration = 2;
    bm.audioClips.find((c) => c.id === "b-a2")!.volume = 0.2;
    const t = renderTimeline([piece("a", "A"), b, piece("c", "C")]);
    const [head] = t.split("\n");
    expect(head).toContain("Match the first: C.");
    expect(head).toContain("Differ: B (2 lines)");
    expect(t).toContain("  b-c code 9.5–11.5 z3 End card ≠time");
    expect(t).toContain("  b-a2 bed.mp3 0–12.4 vol0.2 duck(b-a1 -12dB) copyrighted(Dreams) ≠vol");
    expect(t).toContain("  b-t =");
  });

  it("treats a different sidechain as different, but the same sidechain under another id as the same", () => {
    const b = piece("b", "B");
    (b.manifest as unknown as { audioClips: { duck: { sidechainClipIds: string[] } }[] }).audioClips[1].duck.sidechainClipIds = ["b-a2"];
    const t = renderTimeline([piece("a", "A"), b]);
    expect(t).toMatch(/b-a2 .* ≠duck/);
    expect(body(renderTimeline([piece("a", "A"), piece("b", "B")]))).not.toContain("≠");
  });

  it("flags a header that differs (duration, size, draft) and a piece with fewer layers", () => {
    const b = piece("b", "B", {}, false);
    (b.manifest as unknown as { overlays: unknown[] }).overlays.pop();
    const t = renderTimeline([piece("a", "A"), b]);
    expect(t).toContain("≠header");
    expect(t).toContain("(the first piece has 1 more)");
    expect(t.split("\n")[0]).toContain("Differ: B");
  });

  it("marks a layer the first piece does not have as new", () => {
    const b = piece("b", "B");
    (b.manifest as unknown as { overlays: unknown[] }).overlays.push({
      id: "b-x", kind: "text", content: "extra", font: "x", color: "#fff", align: "left", startTime: 0, duration: 1, z: -1, opacity: 1, rect,
    });
    expect(renderTimeline([piece("a", "A"), b])).toMatch(/b-x text 0–1 z-1 extra ≠new/);
  });
});
