import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { seedTemplateFixturePiece, type FixtureIds } from "@/__tests__/helpers/template-fixture-piece";
import { validateScaffold } from "@/lib/templates/scaffold";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import { eq } from "drizzle-orm";
import { files } from "@/lib/db/schema/sqlite";
import { effectiveRights } from "@/lib/audio-rights/read";

let testDb: ReturnType<typeof createTestDb>;
let storageDir: string;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(storageDir) }));
// The one rights reader, passed through; a test may make it answer a value no
// stored row can hold (the stored schema already caps what it parses).
vi.mock("@/lib/audio-rights/read", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/audio-rights/read")>();
  return { ...real, effectiveRights: vi.fn(real.effectiveRights) };
});

import { extractScaffold, slugifyKey, uniqueKey } from "@/lib/templates/extract";

/** A copyrighted stamp that names no song — what a remote import carries. An
 *  unstamped file reads as the user's own (owner decision 2026-09-28), so the
 *  copyrighted cases stamp explicitly. */
const COPYRIGHTED_NO_TRACK = JSON.stringify({ class: "copyrighted", decidedBy: "provenance", decidedAt: "2026-09-27T00:00:00.000Z" });

describe("extractScaffold", () => {
  let pieceId: string;
  let ids: FixtureIds;
  beforeEach(async () => {
    storageDir = createTempStorageDir();
    testDb = createTestDb();
    ({ pieceId, ids } = await seedTemplateFixturePiece(testDb as never, storageDir));
  });
  afterEach(() => {
    resetTestDb();
    cleanupTempDir(storageDir);
  });

  it("slugifies keys and de-duplicates with -2, -3", () => {
    expect(slugifyKey("Hello World!", "text-1")).toBe("hello-world");
    expect(slugifyKey("!!!", "text-1")).toBe("text-1");
    expect(slugifyKey("9lives", "x")).toBe("x-9lives");
    const taken = new Set(["logo", "logo-2"]);
    expect(uniqueKey("logo", taken)).toBe("logo-3");
  });

  it("produces a valid scaffold with every kind, one asset per file, fonts and caption styles inlined", async () => {
    const r = await extractScaffold(pieceId);
    expect(validateScaffold(r.scaffold).ok).toBe(true);
    const byKey = Object.fromEntries(r.scaffold.overlays.map((o) => [o.key, o]));
    expect(Object.keys(byKey).sort()).toEqual(["background", "floating-title", "headline", "logo", "name-tag", "sparkle"]);
    expect(byKey.headline.kind).toBe("text");
    expect((byKey.headline as { text: unknown }).text).toEqual({ fixed: "Hello" });
    expect((byKey.headline as { fontFileId?: string }).fontFileId).toBe("font-1");
    // `caption` never travels: the reusable half is inlined into captionStyles.
    expect((byKey.headline as { caption?: unknown }).caption).toBeUndefined();
    expect(r.scaffold.fonts).toEqual([{ family: `libifont-${ids.fontFileId}`, assetRef: "font-1" }]);
    expect(r.scaffold.captionStyles).toEqual([{ id: "brand-gold", fields: { color: "#ffd400", stroke: { color: "#000", width: 8 } } }]);
    expect((byKey.logo as { source: unknown }).source).toEqual({ assetRef: "logo" });
    expect((byKey.background as { source: unknown }).source).toEqual({ assetRef: "background-clip" });
    expect(byKey.sparkle.codeFile).toBe("overlays/sparkle/draw.jsx");
    expect(byKey["floating-title"].codeFile).toBe("overlays/floating-title/scene.jsx");
    // tracked → code with the same body and rect, trackId gone
    expect(byKey["name-tag"].kind).toBe("code");
    expect(byKey["name-tag"].codeFile).toBe("overlays/name-tag/draw.jsx");
    expect(byKey["name-tag"].rect).toEqual({ x: 100, y: 100, width: 200, height: 200 });
    expect(JSON.stringify(r.scaffold)).not.toContain("trackId");
    expect(r.writes.find((w) => w.rel === "overlays/name-tag/draw.jsx")?.body).toContain("strokeRect");
    expect(r.trackingAppendix).toContain("## Tracking to re-do");
    expect(r.trackingAppendix).toContain("lisa");
    // The video file is used by the video overlay AND by clip A's inline audio —
    // ONE asset, copied once: an inline clip's audio IS that video's audio track.
    expect(r.scaffold.assets.map((a) => a.ref).sort()).toEqual(["background-clip", "font-1", "logo", "music"]);
    expect(r.copies.map((c) => c.rel).sort()).toEqual([
      "assets/background-clip.mp4", "assets/font-1.ttf", "assets/logo.png", "assets/music.mp3",
    ]);
    expect(r.copies.every((c) => fs.existsSync(c.from))).toBe(true);
    // clips: ids → keys
    const clips = Object.fromEntries(r.scaffold.audioClips.map((c) => [c.key, c]));
    expect(clips["background-audio"].linkedOverlayId).toBe("background");
    expect(clips["background-audio"].source).toEqual({ assetRef: "background-clip" });
    expect(clips["music"].duck?.sidechainClipIds).toEqual(["background-audio"]);
    expect(clips["music"].source).toEqual({ assetRef: "music" });
    expect(r.scaffold.duration).toBe(4);
    expect(r.scaffold.canvas).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(r.keyByOverlayId[ids.text]).toBe("headline");
  });

  it("maps slots by fromOverlayKey (key or overlay id), marks text/media slots, and drops the slotted video's inline clip", async () => {
    const r = await extractScaffold(pieceId, {
      slots: [
        { key: "title", kind: "text", label: "Title", fromOverlayKey: "headline", required: true },
        { key: "clip", kind: "video", label: "Clip", fromOverlayKey: ids.video },
        { key: "song", kind: "audio", label: "Song", fromOverlayKey: "music" },
      ],
    });
    const byKey = Object.fromEntries(r.scaffold.overlays.map((o) => [o.key, o]));
    expect((byKey.headline as { text: unknown }).text).toEqual({ slot: "title" });
    expect((byKey.background as { source: unknown }).source).toEqual({ slot: "clip" });
    expect(r.scaffold.audioClips.find((c) => c.key === "music")?.source).toEqual({ slot: "song" });
    expect(r.scaffold.slots.map((s) => s.key)).toEqual(["title", "clip", "song"]);
    expect(r.scaffold.slots[1].required).toBe(false);
    // Clip A is the slotted video overlay's INLINE audio. The user's own clip
    // brings its own audio, so the clip goes with the overlay — and nothing of
    // the author's video file is copied into the template.
    expect(r.scaffold.audioClips.map((c) => c.key)).toEqual(["music"]);
    expect(r.scaffold.assets.map((a) => a.ref).sort()).toEqual(["font-1", "logo"]);
    expect(r.copies.map((c) => c.rel)).not.toContain("assets/background-clip.mp4");
    expect(validateScaffold(r.scaffold).ok).toBe(true);
  });

  it("honours overlayIds and drops a clip linked to an excluded video overlay", async () => {
    const r = await extractScaffold(pieceId, { overlayIds: [ids.text, ids.code] });
    expect(r.scaffold.overlays.map((o) => o.key).sort()).toEqual(["headline", "sparkle"]);
    expect(r.scaffold.audioClips.map((c) => c.key)).toEqual(["music"]);
    expect(r.scaffold.audioClips[0].duck?.sidechainClipIds).toEqual([]);
    expect(r.scaffold.assets.map((a) => a.ref).sort()).toEqual(["font-1", "music"]);
    expect(validateScaffold(r.scaffold).ok).toBe(true);
  });

  it("rejects a slot whose fromOverlayKey names nothing, or whose kind mismatches", async () => {
    await expect(extractScaffold(pieceId, { slots: [{ key: "x", kind: "text", label: "X", fromOverlayKey: "ghost" }] })).rejects.toThrow(/ghost/);
    await expect(extractScaffold(pieceId, { slots: [{ key: "x", kind: "image", label: "X", fromOverlayKey: "headline" }] })).rejects.toThrow(/kind/);
  });

  it("converts a tracked overlay with non-code content into a placeholder code overlay", async () => {
    const { loadManifest, saveManifest } = await import("@/lib/composition/persistence");
    const m = await loadManifest(pieceId);
    const t = m.overlays!.find((o) => o.id === ids.tracked)!;
    if (t.kind === "tracked") t.content = { kind: "emoji", char: "😀" };
    await saveManifest(pieceId, m);
    const r = await extractScaffold(pieceId, { overlayIds: [ids.tracked] });
    const body = r.writes.find((w) => w.rel === "overlays/name-tag/draw.jsx")!.body;
    expect(body).toContain("😀");
    expect(body).toContain("const { ctx");
    expect(r.trackingAppendix).toContain("emoji");
  });

  // Final review I1(a): an asset's extension decides the type it is stored and
  // served as, so extract only ever writes an allowlisted one — taking it from
  // the file's recorded type when the stored name has none it can use.
  it("names an asset by an allowlisted extension", async () => {
    testDb.update(files).set({ filename: "download-0.bin", storagePath: `${pieceId}/download-0.bin` }).where(eq(files.id, ids.imageFileId)).run();
    fs.renameSync(`${storageDir}/${pieceId}/logo.png`, `${storageDir}/${pieceId}/download-0.bin`);
    const r = await extractScaffold(pieceId);
    const logo = r.scaffold.assets.find((a) => a.kind === "image")!;
    expect(logo.file).toBe("assets/logo.png");
    expect(logo.contentType).toBe("image/png");
    expect(validateScaffold(r.scaffold).ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("a copyrighted song becomes a music link (no bytes); a copyrighted video becomes a slot", async () => {
    testDb.update(files).set({ audioRights: JSON.stringify({ class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" }, source: { url: "https://www.youtube.com/watch?v=abc", site: "youtube" }, decidedBy: "agent", decidedAt: "x" }) }).where(eq(files.id, ids.audioFileId)).run();
    testDb.update(files).set({ audioRights: COPYRIGHTED_NO_TRACK }).where(eq(files.id, ids.videoFileId)).run();
    const r = await extractScaffold(pieceId);
    expect(validateScaffold(r.scaffold).ok).toBe(true);
    expect(r.scaffold.musicLinks).toEqual([{ ref: "espresso", track: { title: "Espresso", artist: "Sabrina Carpenter" }, sourceUrl: "https://www.youtube.com/watch?v=abc" }]);
    const music = r.scaffold.audioClips.find((c) => c.key === "music")!;
    expect(music.source).toEqual({ musicRef: "espresso" });
    expect(r.copies.map((c) => c.rel)).not.toContain("assets/music.mp3");
    expect(r.copies.map((c) => c.rel)).not.toContain("assets/background-clip.mp4");
    expect((r.scaffold.overlays.find((o) => o.key === "background") as { source: unknown }).source).toEqual({ slot: expect.any(String) });
    expect(r.warnings).toContain("music not included: Espresso — Sabrina Carpenter; applying the template leaves it out until the agent fetches it");
    expect(r.warnings.some((w) => /bg\.mp4 carries copyrighted audio; video overlay "background" is now the unfilled slot/.test(w))).toBe(true);
  });

  describe("a clip's gain, volume envelope and crossfade", () => {
    const ENV = { keyframes: [{ t: 0, value: 0 }, { t: 1, value: -18, easing: "ease-in" }, { t: 3, value: 3 }] };
    async function shape() {
      const m = await loadManifest(pieceId);
      const music = m.audioClips!.find((c) => c.id === ids.clipB)!;
      Object.assign(music, { gainDb: -6, volumeKeyframes: ENV });
      m.audioClips!.find((c) => c.id === ids.clipA)!.crossfadeMs = 500;
      await saveManifest(pieceId, m);
    }

    it("travel on a created clip through extract and the scaffold schema", async () => {
      await shape();
      const r = await extractScaffold(pieceId);
      const v = validateScaffold(r.scaffold);
      expect(v.ok).toBe(true);
      const clips = v.ok ? v.scaffold.audioClips : [];
      expect(clips.find((c) => c.key === "music")).toMatchObject({ gainDb: -6, volumeKeyframes: ENV });
      expect(clips.find((c) => c.key === "background-audio")?.crossfadeMs).toBe(500);
      // A clip with none carries none.
      expect(clips.find((c) => c.key === "music")?.crossfadeMs).toBeUndefined();
    });

    it("travel on a clip left pending as a music link", async () => {
      await shape();
      testDb.update(files).set({ audioRights: COPYRIGHTED_NO_TRACK }).where(eq(files.id, ids.audioFileId)).run();
      const r = await extractScaffold(pieceId);
      const v = validateScaffold(r.scaffold);
      expect(v.ok).toBe(true);
      const music = (v.ok ? v.scaffold.audioClips : []).find((c) => c.key === "music")!;
      expect(music.source).toEqual({ musicRef: "music" });
      expect(music).toMatchObject({ gainDb: -6, volumeKeyframes: ENV });
    });

    it("are refused by the scaffold schema when out of range", async () => {
      await shape();
      const { scaffold } = await extractScaffold(pieceId);
      const withClip = (patch: Record<string, unknown>) => ({
        ...scaffold,
        audioClips: scaffold.audioClips.map((c) => (c.key === "music" ? { ...c, ...patch } : c)),
      });
      for (const patch of [
        { gainDb: 13 },
        { gainDb: -61 },
        { crossfadeMs: 5001 },
        { crossfadeMs: -1 },
        { volumeKeyframes: { keyframes: [{ t: 0, value: 13 }] } },
        { volumeKeyframes: { keyframes: [{ t: -1, value: 0 }] } },
        { volumeKeyframes: { keyframes: [{ t: 0, value: 0, easing: "x".repeat(41) }] } },
        { volumeKeyframes: { keyframes: Array.from({ length: 201 }, (_, i) => ({ t: i, value: 0 })) } },
      ]) {
        expect(validateScaffold(withClip(patch)).ok, JSON.stringify(patch).slice(0, 60)).toBe(false);
      }
    });
  });

  // Owner decision 2026-09-28: an unstamped file is the user's own upload, so
  // the template carries its bytes like any other owned asset.
  it("an unstamped (null rights) audio file is the user's own: carried as bytes, no music link", async () => {
    testDb.update(files).set({ audioRights: null }).where(eq(files.id, ids.audioFileId)).run();
    const r = await extractScaffold(pieceId);
    expect(validateScaffold(r.scaffold).ok).toBe(true);
    expect(r.scaffold.musicLinks ?? []).toEqual([]);
    expect(r.scaffold.audioClips.find((c) => c.key === "music")!.source).toEqual({ assetRef: expect.any(String) });
    expect(r.copies.map((c) => c.rel)).toContain("assets/music.mp3");
  });

  // Task 20 review, Minor 4: a copyrighted file with no track (a remote import).
  it("a copyrighted audio file with no track becomes a music link named by the file, with no source link", async () => {
    testDb.update(files).set({ audioRights: COPYRIGHTED_NO_TRACK }).where(eq(files.id, ids.audioFileId)).run();
    const r = await extractScaffold(pieceId);
    expect(validateScaffold(r.scaffold).ok).toBe(true);
    expect(r.scaffold.musicLinks).toEqual([{ ref: "music", track: { title: "Music" } }]);
    expect(r.scaffold.audioClips.find((c) => c.key === "music")!.source).toEqual({ musicRef: "music" });
    expect(r.copies.map((c) => c.rel)).not.toContain("assets/music.mp3");
    expect(r.warnings).toContain("music not included: Music; applying the template leaves it out until the agent fetches it");
  });

  // Task 20 review, Minor 2: track.title has min(1) in the scaffold schema.
  it("a file with an empty name falls back to its filename for the music link's title", async () => {
    testDb.update(files).set({ audioRights: COPYRIGHTED_NO_TRACK, name: "" }).where(eq(files.id, ids.audioFileId)).run();
    const r = await extractScaffold(pieceId);
    expect(validateScaffold(r.scaffold).ok).toBe(true);
    expect(r.scaffold.musicLinks).toEqual([{ ref: "music-mp3", track: { title: "music.mp3" } }]);
  });

  // Task 20 review, Minor 2: a link the scaffold would refuse is not kept.
  it("a source link over the scaffold's url cap is left off (the scaffold stays valid)", async () => {
    const long = `https://www.youtube.com/watch?v=${"a".repeat(2100)}`;
    testDb.update(files).set({ audioRights: COPYRIGHTED_NO_TRACK }).where(eq(files.id, ids.audioFileId)).run();
    vi.mocked(effectiveRights).mockImplementation((f) =>
      (f as { id?: string }).id === ids.audioFileId
        ? { class: "copyrighted", track: { title: "Espresso" }, source: { url: long }, decidedBy: "agent", decidedAt: "x" }
        : null,
    );
    try {
      const r = await extractScaffold(pieceId);
      expect(validateScaffold(r.scaffold).ok).toBe(true);
      expect(r.scaffold.musicLinks).toEqual([{ ref: "espresso", track: { title: "Espresso" } }]);
    } finally {
      vi.mocked(effectiveRights).mockReset();
      const real = await vi.importActual<typeof import("@/lib/audio-rights/read")>("@/lib/audio-rights/read");
      vi.mocked(effectiveRights).mockImplementation(real.effectiveRights);
    }
  });

  // Task 20 review, Minor 4: a STANDALONE clip on a copyrighted video file is
  // a song like any other — named, never carried. (The video overlay on that
  // file still becomes a slot; only an INLINE clip follows its overlay.)
  it("a standalone clip on a copyrighted VIDEO file becomes a music link", async () => {
    const { loadManifest, saveManifest } = await import("@/lib/composition/persistence");
    const m = await loadManifest(pieceId);
    const clip = m.audioClips!.find((c) => c.id === ids.clipB)!;
    clip.fileId = ids.videoFileId;
    await saveManifest(pieceId, m);
    testDb.update(files).set({ audioRights: COPYRIGHTED_NO_TRACK }).where(eq(files.id, ids.videoFileId)).run();
    const r = await extractScaffold(pieceId);
    expect(validateScaffold(r.scaffold).ok).toBe(true);
    expect(r.scaffold.musicLinks).toEqual([{ ref: "background-clip", track: { title: "Background clip" } }]);
    expect(r.scaffold.audioClips.find((c) => c.key === "music")!.source).toEqual({ musicRef: "background-clip" });
    expect(r.copies.map((c) => c.rel)).not.toContain("assets/background-clip.mp4");
    expect((r.scaffold.overlays.find((o) => o.key === "background") as { source: unknown }).source).toEqual({ slot: expect.any(String) });
  });

  // Final re-review 1, Minor: a file outside the media allowlist (HEIC, BMP,
  // AVI, AIFF, …, or HTML) threw `asset_type_unsupported` and failed the whole
  // template. It is now skipped with a warning, and the layer that used it
  // becomes an unfilled slot the user fills on apply.
  describe("a file a template cannot carry", () => {
    /** Point `fileId`'s row (and its bytes) at a new name and type. */
    function retype(fileId: string, from: string, filename: string, contentType: string) {
      testDb.update(files).set({ filename, contentType, storagePath: `${pieceId}/${filename}` }).where(eq(files.id, fileId)).run();
      fs.renameSync(`${storageDir}/${pieceId}/${from}`, `${storageDir}/${pieceId}/${filename}`);
    }

    it("an image overlay's file becomes an unfilled image slot, with a warning", async () => {
      retype(ids.imageFileId, "logo.png", "photo.heic", "image/heic");
      const r = await extractScaffold(pieceId);
      expect(validateScaffold(r.scaffold).ok).toBe(true);
      const logo = r.scaffold.overlays.find((o) => o.key === "logo")!;
      expect(logo.source).toEqual({ slot: "logo" });
      expect(r.scaffold.slots).toEqual([
        expect.objectContaining({ key: "logo", kind: "image", label: "Logo", required: false }),
      ]);
      expect(r.scaffold.slots[0].hint).toMatch(/photo\.heic/);
      expect(r.scaffold.assets.some((a) => a.kind === "image")).toBe(false);
      expect(r.copies.some((c) => c.from.endsWith("photo.heic"))).toBe(false);
      expect(r.warnings).toEqual([expect.stringMatching(/photo\.heic.*logo/)]);
    });

    it("a video overlay's file becomes a video slot, and its inline clip goes with it", async () => {
      retype(ids.videoFileId, "bg.mp4", "bg.avi", "video/x-msvideo");
      const r = await extractScaffold(pieceId);
      expect(validateScaffold(r.scaffold).ok).toBe(true);
      expect(r.scaffold.overlays.find((o) => o.key === "background")!.source).toEqual({ slot: "background" });
      expect(r.scaffold.slots.map((s) => [s.key, s.kind])).toEqual([["background", "video"]]);
      expect(r.scaffold.audioClips.map((c) => c.key)).toEqual(["music"]);
      expect(r.scaffold.audioClips[0].duck?.sidechainClipIds).toEqual([]);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/bg\.avi/);
    });

    it("a clip's file becomes an audio slot", async () => {
      retype(ids.audioFileId, "music.mp3", "music.aiff", "audio/aiff");
      const r = await extractScaffold(pieceId);
      expect(validateScaffold(r.scaffold).ok).toBe(true);
      expect(r.scaffold.audioClips.find((c) => c.key === "music")!.source).toEqual({ slot: "music" });
      expect(r.scaffold.slots.map((s) => [s.key, s.kind])).toEqual([["music", "audio"]]);
      expect(r.warnings[0]).toMatch(/music\.aiff/);
    });

    it("a font that is not a font file is skipped; the text keeps its family and renders in a fallback", async () => {
      retype(ids.fontFileId, "Brand.ttf", "Brand.pfb", "application/x-font-type1");
      const r = await extractScaffold(pieceId);
      expect(validateScaffold(r.scaffold).ok).toBe(true);
      const headline = r.scaffold.overlays.find((o) => o.key === "headline") as { fontFileId?: string };
      expect(headline.fontFileId).toBeUndefined();
      expect(r.scaffold.fonts).toEqual([]);
      expect(r.warnings).toEqual([expect.stringMatching(/Brand\.pfb.*headline/)]);
    });

    it("an auto slot never takes a key the caller's slots use", async () => {
      retype(ids.imageFileId, "logo.png", "logo.bmp", "image/bmp");
      const r = await extractScaffold(pieceId, { slots: [{ key: "logo", kind: "text", label: "Logo text", fromOverlayKey: "headline" }] });
      expect(validateScaffold(r.scaffold).ok).toBe(true);
      expect(r.scaffold.slots.map((s) => s.key)).toEqual(["logo", "logo-2"]);
      expect(r.scaffold.overlays.find((o) => o.key === "logo")!.source).toEqual({ slot: "logo-2" });
    });

    it("with no slot left, the layer is dropped with a warning naming it", async () => {
      retype(ids.imageFileId, "logo.png", "logo.bmp", "image/bmp");
      const full = Array.from({ length: 12 }, (_, i) => ({ key: `s${i}`, kind: "text" as const, label: `S${i}` }));
      const r = await extractScaffold(pieceId, { slots: full });
      expect(validateScaffold(r.scaffold).ok).toBe(true);
      expect(r.scaffold.overlays.map((o) => o.key)).not.toContain("logo");
      expect(r.scaffold.slots).toHaveLength(12);
      expect(r.warnings).toEqual([expect.stringMatching(/logo\.bmp.*"logo".*dropped/)]);
    });
  });
});
