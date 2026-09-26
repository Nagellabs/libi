import { describe, it, expect } from "vitest";
import { validateScaffold, normalizeTags, tagsError, codeFileFor, TEMPLATE_LIMITS, type TemplateScaffold } from "@/lib/templates/scaffold";

function valid(): TemplateScaffold {
  return {
    schema: 1,
    name: "Lower third",
    description: "A name card that slides in",
    tags: ["promo", "name-card"],
    canvas: { width: 1080, height: 1920, fps: 30 },
    duration: 5,
    slots: [
      { key: "headline", kind: "text", label: "Headline", required: true },
      { key: "clip", kind: "video", label: "Background clip", required: false },
    ],
    overlays: [
      { key: "title", kind: "text", startTime: 0, duration: 5, rect: { x: 0, y: 0, width: 1080, height: 200 }, z: 1, opacity: 1, text: { slot: "headline" }, font: "700 64px Inter", color: "#fff", align: "center" },
      { key: "bg", kind: "video", startTime: 0, duration: 5, rect: { x: 0, y: 0, width: 1080, height: 1920 }, z: 0, opacity: 1, source: { slot: "clip" } },
      { key: "logo", kind: "image", startTime: 0, duration: 5, rect: { x: 10, y: 10, width: 100, height: 100 }, z: 2, opacity: 1, source: { assetRef: "logo" } },
      { key: "sparkle", kind: "code", startTime: 0, duration: 5, rect: { x: 0, y: 0, width: 1080, height: 1920 }, z: 3, opacity: 1, codeFile: "overlays/sparkle/draw.jsx", displayName: "Sparkle" },
    ] as TemplateScaffold["overlays"],
    audioClips: [
      { key: "music", kind: "standalone", startTime: 0, duration: 5, trimStart: 0, volume: 0.8, enabled: true, source: { assetRef: "music" } },
    ],
    assets: [
      { ref: "logo", kind: "image", file: "assets/logo.png" },
      { ref: "music", kind: "audio", url: "https://cdn.example.com/music.mp3", bytes: 1234 },
    ],
    fonts: [],
    captionStyles: [],
  };
}

function reasonOf(mutate: (s: TemplateScaffold) => void): string {
  const s = valid();
  mutate(s);
  const r = validateScaffold(s);
  if (r.ok) throw new Error("expected the scaffold to be rejected");
  return r.reason;
}

describe("validateScaffold", () => {
  it("accepts the fixture and strips unknown top-level fields", () => {
    const r = validateScaffold({ ...valid(), extra: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect("extra" in r.scaffold).toBe(false);
  });
  it("rejects schema !== 1", () => expect(reasonOf((s) => ((s as { schema: number }).schema = 2))).toMatch(/schema/));
  it("rejects a name over 80 chars", () => expect(reasonOf((s) => (s.name = "x".repeat(81)))).toMatch(/name/));
  it("rejects a description over 500 chars", () => expect(reasonOf((s) => (s.description = "x".repeat(501)))).toMatch(/description/));
  it("rejects more than 10 tags and a tag with uppercase", () => {
    expect(reasonOf((s) => (s.tags = Array.from({ length: 11 }, (_, i) => `t${i}`)))).toMatch(/tags/);
    expect(reasonOf((s) => (s.tags = ["Promo"]))).toMatch(/tags/);
  });
  it("rejects > 60 overlays, > 20 clips, > 30 assets, > 12 slots", () => {
    expect(reasonOf((s) => (s.overlays = Array.from({ length: 61 }, (_, i) => ({ ...s.overlays[3], key: `k${i}`, codeFile: `overlays/k${i}/draw.jsx` }))))).toMatch(/overlays/);
    expect(reasonOf((s) => (s.audioClips = Array.from({ length: 21 }, (_, i) => ({ ...s.audioClips[0], key: `c${i}` }))))).toMatch(/audioClips/);
    expect(reasonOf((s) => (s.assets = Array.from({ length: 31 }, (_, i) => ({ ref: `a${i}`, kind: "image" as const, file: `assets/a${i}.png` }))))).toMatch(/assets/);
    expect(reasonOf((s) => (s.slots = Array.from({ length: 13 }, (_, i) => ({ key: `s${i}`, kind: "text" as const, label: "x", required: false }))))).toMatch(/slots/);
  });
  it("rejects a slot key that breaks ^[a-z][a-z0-9-]{0,39}$", () => {
    expect(reasonOf((s) => (s.slots[0].key = "1bad"))).toMatch(/key/);
    expect(reasonOf((s) => (s.slots[0].key = "a".repeat(41)))).toMatch(/key/);
  });
  it("rejects an asset ref that breaks the key regex", () => expect(reasonOf((s) => (s.assets[0].ref = "Logo"))).toMatch(/ref/));
  it("rejects a codeFile with .., a leading slash, a backslash, or the wrong key", () => {
    for (const bad of ["overlays/../draw.jsx", "/overlays/sparkle/draw.jsx", "overlays\\sparkle\\draw.jsx", "overlays/other/draw.jsx", "overlays/sparkle/scene.jsx"]) {
      expect(reasonOf((s) => ((s.overlays[3] as { codeFile: string }).codeFile = bad)), bad).toMatch(/codeFile/);
    }
  });
  it("rejects an asset file that is not assets/<basename>", () => {
    for (const bad of ["logo.png", "assets/sub/logo.png", "assets/../x.png", "/assets/logo.png", "assets\\logo.png"]) {
      expect(reasonOf((s) => (s.assets[0].file = bad)), bad).toMatch(/file/);
    }
  });
  it("rejects an asset with both file and url, or neither", () => {
    expect(reasonOf((s) => (s.assets[0].url = "https://x.example/a.png"))).toMatch(/exactly one/);
    expect(reasonOf((s) => delete s.assets[0].file)).toMatch(/exactly one/);
  });
  it("rejects http: and over-long urls", () => {
    expect(reasonOf((s) => (s.assets[1].url = "http://cdn.example.com/music.mp3"))).toMatch(/https/);
    expect(reasonOf((s) => (s.assets[1].url = "https://cdn.example.com/" + "a".repeat(TEMPLATE_LIMITS.urlBytes)))).toMatch(/url/);
  });
  it("rejects id, fileId, trackId, content, drawFunction and sceneFunction on an overlay", () => {
    for (const k of ["id", "fileId", "trackId", "content", "drawFunction", "sceneFunction"]) {
      expect(reasonOf((s) => ((s.overlays[0] as Record<string, unknown>)[k] = "x")), k).toMatch(new RegExp(k));
    }
  });
  it("rejects a tracked overlay kind outright", () => expect(reasonOf((s) => ((s.overlays[0] as { kind: string }).kind = "tracked"))).toMatch(/kind/));
  it("requires text on text overlays, source on image/video, codeFile on code/three, and nothing else", () => {
    expect(reasonOf((s) => delete (s.overlays[0] as { text?: unknown }).text)).toMatch(/text/);
    expect(reasonOf((s) => delete (s.overlays[1] as { source?: unknown }).source)).toMatch(/source/);
    expect(reasonOf((s) => delete (s.overlays[3] as { codeFile?: unknown }).codeFile)).toMatch(/codeFile/);
    expect(reasonOf((s) => ((s.overlays[0] as { source?: unknown }).source = { assetRef: "logo" }))).toMatch(/source/);
  });
  it("rejects dangling slot / asset / font / clip references and kind mismatches", () => {
    expect(reasonOf((s) => ((s.overlays[0] as { text: unknown }).text = { slot: "nope" }))).toMatch(/slot/);
    expect(reasonOf((s) => ((s.overlays[1] as { source: unknown }).source = { slot: "headline" }))).toMatch(/kind/);
    expect(reasonOf((s) => ((s.overlays[2] as { source: unknown }).source = { assetRef: "music" }))).toMatch(/kind/);
    expect(reasonOf((s) => (s.fonts = [{ family: "libifont-x", assetRef: "logo" }]))).toMatch(/font/);
    expect(reasonOf((s) => ((s.overlays[0] as { fontFileId?: string }).fontFileId = "nope"))).toMatch(/fontFileId/);
    expect(reasonOf((s) => (s.audioClips[0].linkedOverlayId = "title"))).toMatch(/linkedOverlayId/);
    expect(reasonOf((s) => (s.audioClips[0].duck = { sidechainClipIds: ["ghost"], thresholdDb: -20, ratio: 4, attackMs: 10, releaseMs: 200, reductionDb: 12 }))).toMatch(/sidechainClipIds/);
  });
  // An inline clip's audio IS its video overlay's audio track, so it points at
  // the same `video` asset instead of a second copy of the same file.
  it("accepts an inline clip whose source names the video asset it is linked to", () => {
    const s = valid();
    s.assets.push({ ref: "bg-file", kind: "video", file: "assets/bg-file.mp4" });
    (s.overlays[1] as { source: unknown }).source = { assetRef: "bg-file" };
    s.audioClips[0] = { ...s.audioClips[0], kind: "inline", linkedOverlayId: "bg", source: { assetRef: "bg-file" } };
    const r = validateScaffold(s);
    expect(r.ok).toBe(true);
  });
  it("still rejects a standalone clip whose source names a video asset", () => {
    expect(
      reasonOf((s) => {
        s.assets.push({ ref: "bg-file", kind: "video", file: "assets/bg-file.mp4" });
        s.audioClips[0] = { ...s.audioClips[0], kind: "standalone", source: { assetRef: "bg-file" } };
      }),
    ).toMatch(/kind/);
  });
  it("rejects duplicate keys across overlays, clips, slots and assets", () => {
    expect(reasonOf((s) => (s.overlays[1].key = "title"))).toMatch(/duplicate/);
    expect(reasonOf((s) => (s.assets[1].ref = "logo"))).toMatch(/duplicate/);
  });
  it("rejects a captionStyles id that is not a preset slug", () => expect(reasonOf((s) => (s.captionStyles = [{ id: "Bad Id", fields: {} }]))).toMatch(/captionStyles/));
  // A caption group ref is footage-specific and carries the piece-scoped
  // `groupId`; the reusable half travels as `captionStyles[]` instead.
  it("rejects caption and trackContent on an overlay", () => {
    expect(reasonOf((s) => ((s.overlays[0] as Record<string, unknown>).caption = { groupId: "grp_1", useTrackStyle: true }))).toMatch(/caption/);
    expect(reasonOf((s) => ((s.overlays[0] as Record<string, unknown>).trackContent = { kind: "emoji", char: "x" }))).toMatch(/trackContent/);
  });
  it("rejects the deprecated singular duck.sidechainClipId, which is a clip id", () => {
    expect(
      reasonOf((s) => (s.audioClips[0].duck = { sidechainClipIds: ["music"], sidechainClipId: "clip_abc", thresholdDb: -20, ratio: 4, attackMs: 10, releaseMs: 200, reductionDb: 12 } as never)),
    ).toMatch(/sidechainClipId/);
  });
  it("requires font, color and align on a text overlay", () => {
    expect(reasonOf((s) => delete (s.overlays[0] as { font?: unknown }).font)).toMatch(/font/);
    expect(reasonOf((s) => delete (s.overlays[0] as { color?: unknown }).color)).toMatch(/color/);
    expect(reasonOf((s) => delete (s.overlays[0] as { align?: unknown }).align)).toMatch(/align/);
    expect(reasonOf((s) => ((s.overlays[0] as { align: string }).align = "middle"))).toMatch(/align/);
  });

  // Final review I4: overlays and clips used to be `.passthrough()`, so every
  // unknown key — including libi's own runtime markers — landed in the piece.
  it("strips unknown overlay keys, internal markers and cross-kind fields; keeps each kind's own", () => {
    const s = valid();
    const o = s.overlays as unknown as Array<Record<string, unknown>>;
    Object.assign(o[0], { bogus: 1, version: 1e9, trim: { start: 0, end: 1 }, effects: { in: { effectId: "fade" } }, anchor: "top-left" });
    Object.assign(o[1], { unfilledSlot: "clip", missing: true, videoUrl: "/x", sourceWidth: 1, trim: { start: 0, end: 2 }, fit: "contain" });
    Object.assign(o[2], { missing: true, fit: "contain" });
    Object.assign(o[3], { cameraPreset: "ground", scale: 2, hidden: true });
    const r = validateScaffold(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [text, video, image, code] = r.scaffold.overlays as unknown as Array<Record<string, unknown>>;
    for (const k of ["bogus", "version", "trim"]) expect(text, k).not.toHaveProperty(k);
    expect(text.effects).toEqual({ in: { effectId: "fade" } });
    expect(text.anchor).toBe("top-left");
    for (const k of ["unfilledSlot", "missing", "videoUrl", "sourceWidth"]) expect(video, k).not.toHaveProperty(k);
    expect(video.trim).toEqual({ start: 0, end: 2 });
    expect(video.fit).toBe("contain");
    expect(image).not.toHaveProperty("missing");
    expect(image).not.toHaveProperty("fit");
    expect(code).not.toHaveProperty("cameraPreset");
    expect(code).not.toHaveProperty("scale");
    expect(code.hidden).toBe(true);
  });
  it("strips unknown clip and duck keys", () => {
    const s = valid();
    Object.assign(s.audioClips[0] as unknown as Record<string, unknown>, {
      bogus: true,
      linkedSceneId: "scene-1",
      duck: { sidechainClipIds: [], thresholdDb: -20, ratio: 4, attackMs: 10, releaseMs: 200, reductionDb: 12, extra: "x" },
    });
    const r = validateScaffold(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const clip = r.scaffold.audioClips[0] as unknown as Record<string, unknown>;
    expect(clip).not.toHaveProperty("bogus");
    expect(clip).not.toHaveProperty("linkedSceneId");
    expect(clip.duck).not.toHaveProperty("extra");
    expect(clip.volume).toBe(0.8);
  });
  // Final review I2: a caption style's fields became a user preset verbatim, and
  // applying that preset could turn a text overlay into a three overlay.
  it("keeps only a caption style's look keys", () => {
    const s = valid();
    s.captionStyles = [
      {
        id: "neon",
        fields: {
          kind: "three",
          id: "text-evil",
          sceneFunction: "fetch('/api/pieces')",
          drawFunction: "x",
          content: "hijacked",
          fileId: "f",
          version: 9,
          color: "#0ff",
          stroke: { color: "#000", width: 4, extra: 1 },
        },
      },
    ];
    const r = validateScaffold(s);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scaffold.captionStyles[0].fields).toEqual({ color: "#0ff", stroke: { color: "#000", width: 4 } });
  });
  it("rejects `assets/.`, a dot-file, and a file extension its kind does not allow", () => {
    for (const bad of ["assets/.", "assets/.hidden.png"]) expect(reasonOf((s) => (s.assets[0].file = bad)), bad).toMatch(/file/);
    expect(reasonOf((s) => (s.assets[0].file = "assets/logo.html"))).toMatch(/file/);
    expect(reasonOf((s) => (s.assets[0].file = "assets/logo.mp4"))).toMatch(/file/);
    expect(reasonOf((s) => (s.assets[0].file = "assets/logo"))).toMatch(/file/);
  });
  // Final re-review 1, New breakage 2: a detached or duplicated clip plays a
  // video file's audio, so an audio asset may be a video container.
  it("accepts a video container as an audio asset", () => {
    const s = valid();
    s.assets[1] = { ref: "music", kind: "audio", file: "assets/music.mp4" };
    expect(validateScaffold(s).ok).toBe(true);
  });
});

describe("normalizeTags / tagsError", () => {
  it("lowercases, trims and dedupes", () => expect(normalizeTags([" Promo", "promo", "Name-Card"])).toEqual(["promo", "name-card"]));
  it("reports the first bad tag", () => expect(tagsError(["ok", "-bad"])).toMatch(/-bad/));
  it("reports too many tags", () => expect(tagsError(Array.from({ length: 11 }, (_, i) => `t${i}`))).toMatch(/10/));
});

// `create_template_from_piece` writes code files at `codeFileFor(...)`; the
// validator accepts them only at `overlays/<key>/<draw|scene>.jsx`. The two
// spellings must not drift apart, or every extracted code overlay reads back
// as broken.
describe("codeFileFor", () => {
  it("produces the path validateScaffold requires, for code and for three", () => {
    expect(codeFileFor("code", "sparkle")).toBe("overlays/sparkle/draw.jsx");
    expect(codeFileFor("three", "sparkle")).toBe("overlays/sparkle/scene.jsx");
    const s = valid();
    const o = s.overlays[3] as { kind: string; codeFile: string };
    o.kind = "three";
    o.codeFile = codeFileFor("three", "sparkle");
    expect(validateScaffold(s).ok).toBe(true);
    // `content.jsx` was never a name `codeFileFor` can produce, so the
    // validator must not accept it either.
    o.codeFile = "overlays/sparkle/content.jsx";
    expect(validateScaffold(s).ok).toBe(false);
  });
});

// The pinned schema admits `keyframes.<track>` as anything (it is shared with
// the site byte for byte); the app holds each track to its own shape on every
// read, so a stranger's template cannot hand the renderer a value it would
// lerp into NaN, a string where a rect goes, or a million keyframes.
describe("validateScaffold — keyframe tracks", () => {
  const withKeyframes = (keyframes: unknown) => {
    const s = valid();
    (s.overlays[2] as { keyframes?: unknown }).keyframes = keyframes;
    return validateScaffold(s);
  };
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  const t3 = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };

  it("accepts a well-formed track of each kind and keeps only the keyframe fields", () => {
    const r = withKeyframes({
      rect: { keyframes: [{ t: 0, value: rect, easing: "ease-in-out", junk: 1 }, { t: 1, value: { ...rect, x: 50, extra: "x" } }] },
      opacity: { keyframes: [{ t: 0, value: 0 }, { t: 0.5, value: 1, easing: "cubic-bezier(0.4, 0, 0.2, 1)" }] },
      transform3d: { keyframes: [{ t: 0.25, value: t3 }] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kf = (r.scaffold.overlays[2] as unknown as { keyframes: Record<string, { keyframes: Array<Record<string, unknown>> }> }).keyframes;
    expect(kf.rect.keyframes[0]).toEqual({ t: 0, value: rect, easing: "ease-in-out" });
    expect(kf.rect.keyframes[1].value).toEqual({ ...rect, x: 50 });
    expect(kf.opacity.keyframes).toHaveLength(2);
  });

  it.each([
    ["a track that is not an object", { rect: "slide" }],
    ["a track without a keyframes array", { opacity: { frames: [] } }],
    ["a rect value that is a string", { rect: { keyframes: [{ t: 0, value: "x" }] } }],
    ["a rect value missing a field", { rect: { keyframes: [{ t: 0, value: { x: 0, y: 0, width: 1 } }] } }],
    ["an opacity outside 0..1", { opacity: { keyframes: [{ t: 0, value: 2 }] } }],
    ["a t outside 0..1", { opacity: { keyframes: [{ t: 1.5, value: 1 }] } }],
    ["a non-finite number", { opacity: { keyframes: [{ t: 0, value: Number.POSITIVE_INFINITY }] } }],
    ["a transform3d missing rotation", { transform3d: { keyframes: [{ t: 0, value: { position: { x: 0, y: 0, z: 0 } } }] } }],
    ["an easing that is not a string", { opacity: { keyframes: [{ t: 0, value: 1, easing: 3 }] } }],
    ["an over-long easing", { opacity: { keyframes: [{ t: 0, value: 1, easing: "x".repeat(101) }] } }],
    ["too many keyframes", { opacity: { keyframes: Array.from({ length: 501 }, (_, i) => ({ t: i / 501, value: 1 })) } }],
  ])("refuses %s, naming the track", (_what, keyframes) => {
    const r = withKeyframes(keyframes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^overlays\.2\.keyframes\.(rect|opacity|transform3d)/);
  });
});
