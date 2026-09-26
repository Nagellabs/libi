/**
 * `applyScaffold` against Task 4's extractor: the round trip is the feature's
 * central correctness proof — extract the every-kind fixture piece, apply it
 * into a fresh piece, and the composition must come back equal modulo ids,
 * file ids and the `caption` a scaffold never carries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { seedTemplateFixturePiece, type FixtureIds } from "@/__tests__/helpers/template-fixture-piece";
import { files } from "@/lib/db/schema/sqlite";
import type { TemplateScaffold } from "@/lib/templates/scaffold";
import { loadManifest, saveManifest, type PersistedAudioClip, type PersistedOverlay } from "@/lib/composition/persistence";
import { getUserPreset, saveUserPreset } from "@/lib/overlays/preset-store";
import { applyOverlayPreset } from "@/mcp/tools/overlay-preset-tools";

let testDb: ReturnType<typeof createTestDb>;
let storageDir: string;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(storageDir) }));
vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(async () => ({ status: "new", jobId: "j", clientKey: "k" })),
  LibiServerUnavailableError: class extends Error {},
  logProxyGenEnqueueFailure: () => {},
}));

import { extractScaffold } from "@/lib/templates/extract";
import { createTemplate, getTemplate, templateDir } from "@/lib/templates/store";
import { applyScaffold, type UrlFetcher } from "@/lib/templates/materialize";

const noUrls: UrlFetcher = async (urls) => urls.map((url) => ({ url, error: "unexpected fetch" }));

/** Ids, file ids, code bodies and the font the apply re-mints — everything else
 *  a `PersistedOverlay` carries must survive the round trip. A source `tracked`
 *  overlay is compared as the `code` overlay extract turns it into. */
function normalize(overlays: PersistedOverlay[]) {
  return overlays
    .map((o) => {
      const r = { ...(o as Record<string, unknown>) };
      if (r.kind === "tracked") {
        r.kind = "code";
        for (const k of ["trackId", "content", "fit", "scale", "smoothing"]) delete r[k];
      }
      // `version` is the edit store's per-overlay save counter, not content: a
      // template never carries it (lib/templates/fields.ts).
      for (const k of ["id", "fileId", "drawFunction", "sceneFunction", "fontFileId", "font", "caption", "version"]) delete r[k];
      return r;
    })
    .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
}

/** The clip half of the same proof: ids, the file behind the clip and the two
 *  id-bearing links (`linkedOverlayId`, `duck.sidechainClipIds`) are re-minted
 *  and asserted on their own; every scalar a `PersistedAudioClip` carries —
 *  `kind`, `trimStart`, `volume`, `enabled`, the duck parameters — must survive
 *  untouched. */
function normalizeClips(clips: PersistedAudioClip[]) {
  return clips
    .map((c) => {
      const r = { ...(c as unknown as Record<string, unknown>) };
      for (const k of ["id", "fileId", "linkedOverlayId"]) delete r[k];
      if (r.duck) {
        const duck = { ...(r.duck as Record<string, unknown>) };
        delete duck.sidechainClipIds;
        r.duck = duck;
      }
      return r;
    })
    .sort((a, b) => Number(a.startTime) - Number(b.startTime) || String(a.label).localeCompare(String(b.label)));
}

describe("applyScaffold", () => {
  let srcPieceId: string;
  let ids: FixtureIds;
  /** Every layer fixed — the round trip. */
  let fullId: string;
  /** A text, a video and an audio slot — the slot paths. */
  let templateId: string;

  beforeEach(async () => {
    storageDir = createTempStorageDir();
    testDb = createTestDb();
    ({ pieceId: srcPieceId, ids } = await seedTemplateFixturePiece(testDb as never, storageDir));

    const full = await extractScaffold(srcPieceId);
    fullId = (
      await createTemplate({
        name: "Fixture",
        description: "d",
        tags: ["t"],
        createdFromPieceId: srcPieceId,
        scaffold: full.scaffold,
        instructions: "# Purpose\n",
        copies: full.copies,
        writes: full.writes,
      })
    ).id;

    const slotted = await extractScaffold(srcPieceId, {
      slots: [
        { key: "headline", kind: "text", label: "Headline", required: true, fromOverlayKey: "headline" },
        { key: "clip", kind: "video", label: "Background clip", required: true, fromOverlayKey: ids.video },
        { key: "song", kind: "audio", label: "Music", required: false, fromOverlayKey: "music" },
      ],
    });
    templateId = (
      await createTemplate({
        name: "Fixture with slots",
        description: "d",
        tags: ["t"],
        createdFromPieceId: srcPieceId,
        scaffold: slotted.scaffold,
        instructions: "# Purpose\n",
        copies: slotted.copies,
        writes: slotted.writes,
      })
    ).id;
  });

  afterEach(() => {
    resetTestDb();
    cleanupTempDir(storageDir);
  });

  it("recreates the source piece modulo ids/fileIds, copies media, registers fonts and records the use", async () => {
    const dst = seedPiece(testDb, { id: "dst" });
    const r = await applyScaffold({ templateId: fullId, pieceId: dst, fetchUrls: noUrls });

    expect(r.unfilledSlots).toEqual([]);
    expect(Object.keys(r.overlays).sort()).toEqual(["background", "floating-title", "headline", "logo", "name-tag", "sparkle"]);
    expect(Object.keys(r.clips).sort()).toEqual(["background-audio", "music"]);

    const src = await loadManifest(srcPieceId);
    const out = await loadManifest(dst);
    // The template's canvas wins on a piece with nothing in it.
    expect([out.width, out.height, out.fps]).toEqual([1080, 1920, 30]);
    expect(normalize(out.overlays!)).toEqual(normalize(src.overlays!));

    // Bodies round-tripped BYTE FOR BYTE through the template's code files —
    // truncation or re-indentation on the way out must fail here.
    const srcById = Object.fromEntries(src.overlays!.map((o) => [o.id, o]));
    const srcCode = srcById[ids.code];
    const sparkle = out.overlays!.find((o) => o.id === r.overlays.sparkle)!;
    expect(sparkle.kind === "code" && sparkle.drawFunction).toBe(srcCode.kind === "code" && srcCode.drawFunction);
    const srcThree = srcById[ids.three];
    const three = out.overlays!.find((o) => o.id === r.overlays["floating-title"])!;
    expect(three.kind === "three" && three.sceneFunction).toBe(srcThree.kind === "three" && srcThree.sceneFunction);
    // The tracked overlay's own body, now a plain code overlay's.
    const srcTracked = srcById[ids.tracked];
    const nameTag = out.overlays!.find((o) => o.id === r.overlays["name-tag"])!;
    expect(nameTag.kind).toBe("code");
    expect(nameTag.kind === "code" && nameTag.drawFunction).toBe(
      srcTracked.kind === "tracked" && srcTracked.content.kind === "code" && srcTracked.content.drawFunction,
    );

    // Fresh ids, in the shapes the overlay tools mint.
    expect(r.overlays.headline).toMatch(/^text-[a-z0-9]{8}$/);
    expect(r.overlays.logo).toMatch(/^img-[a-z0-9]{8}$/);
    expect(r.overlays.background).toMatch(/^vid-[a-z0-9]{8}$/);
    expect(r.clips.music).toMatch(/^clip_[a-z0-9]{8}$/);

    // Media copied in as new rows on THIS piece, byte for byte.
    const logo = out.overlays!.find((o) => o.id === r.overlays.logo)!;
    const logoRow = testDb.select().from(files).where(eq(files.id, (logo as { fileId: string }).fileId)).get()!;
    expect(logoRow.pieceId).toBe(dst);
    expect(logoRow.id).not.toBe(ids.imageFileId);
    expect(fs.readFileSync(path.join(storageDir, dst, logoRow.filename)).toString()).toBe("bytes-of-logo.png");

    // ONE stored video serves the video overlay AND its inline clip (the clip's
    // audio IS that video's audio track — extract points both at one asset).
    const bg = out.overlays!.find((o) => o.id === r.overlays.background)!;
    const bgFileId = (bg as { fileId: string }).fileId;
    expect(bgFileId).not.toBe(ids.videoFileId);
    const clipA = out.audioClips!.find((c) => c.id === r.clips["background-audio"])!;
    expect(clipA.fileId).toBe(bgFileId);
    expect(normalizeClips(out.audioClips!)).toEqual(normalizeClips(src.audioClips!));
    expect(testDb.select().from(files).where(eq(files.pieceId, dst)).all()).toHaveLength(4);

    // Font: a new file row, and the `font` shorthand re-familied onto it.
    const headline = out.overlays!.find((o) => o.id === r.overlays.headline)!;
    const fontFileId = (headline as { fontFileId: string }).fontFileId;
    expect(fontFileId).not.toBe(ids.fontFileId);
    expect(headline.kind === "text" && headline.font).toBe(`700 64px libifont-${fontFileId}, sans-serif`);
    expect(headline.kind === "text" && headline.content).toBe("Hello");

    // Clip links and ducking rewritten to the new ids.
    const music = out.audioClips!.find((c) => c.id === r.clips.music)!;
    expect(music.duck?.sidechainClipIds).toEqual([r.clips["background-audio"]]);
    expect(clipA.linkedOverlayId).toBe(r.overlays.background);

    expect(getTemplate(fullId)!.useCount).toBe(1);
    expect(getTemplate(fullId)!.lastUsedAt).not.toBeNull();
  });

  it("keeps the user's own caption style when it is identical, and suffixes it when it is not", async () => {
    const dst = seedPiece(testDb, { id: "dst" });
    const same = await applyScaffold({ templateId: fullId, pieceId: dst, fetchUrls: noUrls });
    // `brand-gold` on this machine already holds exactly these fields.
    expect(same.warnings.join("\n")).toContain("caption styles available: brand-gold");
    expect(await getUserPreset(`brand-gold-${fullId.slice(0, 8)}`)).toBeNull();

    // The user edits their own `brand-gold`; the template's must not clobber it.
    await saveUserPreset({ id: "brand-gold", name: "Mine", kind: "text", source: "user", fields: { color: "#00f" } });
    const dst2 = seedPiece(testDb, { id: "dst2" });
    const r = await applyScaffold({ templateId: fullId, pieceId: dst2, fetchUrls: noUrls });
    const suffixed = `brand-gold-${fullId.slice(0, 8)}`;
    expect(r.warnings.join("\n")).toContain(`caption styles available: ${suffixed}`);
    expect((await getUserPreset(suffixed))?.fields).toEqual({ color: "#ffd400", stroke: { color: "#000", width: 8 } });
    expect((await getUserPreset("brand-gold"))?.fields).toEqual({ color: "#00f" });
  });

  // A8 follow-up (a): an installed template replaced in place at the SAME
  // version can change an asset's bytes and keep its size.
  it("reuses a stored asset only when its bytes match — the same mark and size are not the same file", async () => {
    const dst = seedPiece(testDb, { id: "dst-reuse" });
    const pieceFiles = () => testDb.select().from(files).where(eq(files.pieceId, dst)).all();
    await applyScaffold({ templateId: fullId, pieceId: dst, fetchUrls: noUrls });
    const first = pieceFiles();
    expect(first.length).toBeGreaterThan(0);
    await applyScaffold({ templateId: fullId, pieceId: dst, fetchUrls: noUrls });
    expect(pieceFiles().map((f) => f.id).sort()).toEqual(first.map((f) => f.id).sort());

    const scaffold = JSON.parse(fs.readFileSync(path.join(templateDir(fullId), "template.json"), "utf8")) as TemplateScaffold;
    const asset = scaffold.assets.find((a) => a.file)!;
    const abs = path.join(templateDir(fullId), asset.file!);
    const changed = Buffer.from(fs.readFileSync(abs));
    changed[Math.floor(changed.length / 2)] ^= 0xff;
    fs.writeFileSync(abs, changed);

    await applyScaffold({ templateId: fullId, pieceId: dst, fetchUrls: noUrls });
    const after = pieceFiles();
    const added = after.filter((f) => !first.some((g) => g.id === f.id));
    expect(added).toHaveLength(1);
    expect(added[0].size).toBe(changed.length);
    expect(fs.readFileSync(new LocalFileStorage(storageDir).localPath(dst, added[0].filename))).toEqual(changed);
  });

  it("fills a text, video and audio slot from the piece's own files", async () => {
    const dst = seedPiece(testDb, { id: "dst" });
    fs.mkdirSync(path.join(storageDir, dst), { recursive: true });
    fs.copyFileSync(path.join(storageDir, srcPieceId, "bg.mp4"), path.join(storageDir, dst, "mine.mp4"));
    fs.copyFileSync(path.join(storageDir, srcPieceId, "music.mp3"), path.join(storageDir, dst, "mine.mp3"));
    testDb.insert(files).values({ id: "dst-clip", pieceId: dst, filename: "mine.mp4", name: "mine", description: "", type: "video", storagePath: `${dst}/mine.mp4`, contentType: "video/mp4", size: 10 }).run();
    testDb.insert(files).values({ id: "dst-song", pieceId: dst, filename: "mine.mp3", name: "mine", description: "", type: "audio", storagePath: `${dst}/mine.mp3`, contentType: "audio/mpeg", size: 10 }).run();

    const r = await applyScaffold({
      templateId,
      pieceId: dst,
      slotValues: { headline: "Welcome", clip: "dst-clip", song: "dst-song" },
      fetchUrls: noUrls,
    });
    expect(r.unfilledSlots).toEqual([]);
    // The slotted video overlay's INLINE clip went with it at extract time.
    expect(Object.keys(r.clips)).toEqual(["music"]);

    const m = await loadManifest(dst);
    const headline = m.overlays!.find((o) => o.id === r.overlays.headline)!;
    expect(headline.kind === "text" && headline.content).toBe("Welcome");
    const bg = m.overlays!.find((o) => o.id === r.overlays.background)!;
    expect(bg.kind === "video" && bg.fileId).toBe("dst-clip");
    expect(m.audioClips!.find((c) => c.id === r.clips.music)!.fileId).toBe("dst-song");
    // Nothing of the author's video or music travelled into the template.
    expect(testDb.select().from(files).where(eq(files.pieceId, dst)).all().map((f) => f.filename).sort()).toEqual([
      "font-1.ttf", "logo.png", "mine.mp3", "mine.mp4",
    ]);
  });

  it("append offsets z above the piece's own overlays; replace clears them (and their clips)", async () => {
    const dst = seedPiece(testDb, { id: "dst2" });
    await saveManifest(dst, {
      width: 1080,
      height: 1920,
      fps: 30,
      overlays: [{ id: "keep", kind: "text", startTime: 0, duration: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 40, opacity: 1, content: "old", font: "16px Inter", color: "#fff", align: "left" }],
      audioClips: [],
    });
    await applyScaffold({ templateId: fullId, pieceId: dst, fetchUrls: noUrls });
    const m1 = await loadManifest(dst);
    expect(m1.overlays!.some((o) => o.id === "keep")).toBe(true);
    expect(Math.min(...m1.overlays!.filter((o) => o.id !== "keep").map((o) => o.z))).toBeGreaterThan(40);

    const b = await applyScaffold({ templateId: fullId, pieceId: dst, mode: "replace", fetchUrls: noUrls });
    const m2 = await loadManifest(dst);
    expect(m2.overlays!.some((o) => o.id === "keep")).toBe(false);
    expect(m2.overlays!.map((o) => o.id).sort()).toEqual(Object.values(b.overlays).sort());
    expect(m2.audioClips!.map((c) => c.id).sort()).toEqual(Object.values(b.clips).sort());
    expect(Math.min(...m2.overlays!.map((o) => o.z))).toBe(0);
  });

  // QA fix round 1 (A13): the fixture's seed headline applied one word per line,
  // clipped at the left edge — its rect was normalised (0.8 wide) where a
  // composition is in pixels. The same SHAPE from a real piece — extracted,
  // published as template.json, installed as a stranger's — must apply exactly:
  // the neutralisation touches strings, never a text layer's box, size or alignment.
  it("a published headline template applies its text layer's box, font, colour and alignment unchanged", async () => {
    const { validateScaffold } = await import("@/lib/templates/scaffold");
    const src = seedPiece(testDb, { id: "src-headline" });
    const headline = {
      id: "text-src", kind: "text" as const, startTime: 0, duration: 3, rect: { x: 192, y: 432, width: 1536, height: 216 }, z: 1, opacity: 1,
      content: "Hello", font: "bold 72px Inter", color: "#ffffff", align: "center" as const,
    };
    await saveManifest(src, { width: 1920, height: 1080, fps: 30, overlays: [headline], audioClips: [] });
    const x = await extractScaffold(src, { slots: [{ key: "headline", kind: "text", label: "Headline", required: true, fromOverlayKey: "text-src" }] });
    // What the site stores and an install reads back.
    const v = validateScaffold(JSON.parse(JSON.stringify(x.scaffold)));
    expect(v.ok, v.ok ? "" : v.reason).toBe(true);
    if (!v.ok) return;
    const tid = (
      await createTemplate({ name: "Headline", description: "", tags: [], origin: "installed", cloudId: "hijklmnopqrstuvwxyz2", scaffold: v.scaffold, instructions: "", copies: x.copies, writes: x.writes })
    ).id;

    const dst = seedPiece(testDb, { id: "dst-headline" });
    const r = await applyScaffold({ templateId: tid, pieceId: dst, slotValues: { headline: "Hello from the fixture" }, fetchUrls: noUrls });
    expect(r.leftOut).toEqual([]);
    const m = await loadManifest(dst);
    expect([m.width, m.height]).toEqual([1920, 1080]);
    const applied = m.overlays!.find((o) => o.id === r.overlays[Object.keys(r.overlays)[0]])!;
    expect(applied).toMatchObject({ kind: "text", rect: headline.rect, font: headline.font, color: headline.color, align: "center", content: "Hello from the fixture" });
  });

  it("reports unfilled slots: text gets a placeholder, media an unfilled fileId + warning, audio no clip", async () => {
    const dst = seedPiece(testDb, { id: "dst3" });
    const r = await applyScaffold({ templateId, pieceId: dst, fetchUrls: noUrls });
    expect(r.unfilledSlots.map((s) => s.key)).toEqual(["headline", "clip", "song"]);
    expect(r.clips).toEqual({});

    const m = await loadManifest(dst);
    const headline = m.overlays!.find((o) => o.id === r.overlays.headline)!;
    expect(headline.kind === "text" && headline.content).toBe("Headline (fill me)");
    const bg = m.overlays!.find((o) => o.id === r.overlays.background)!;
    expect(bg.kind === "video" && bg.fileId).toBe("unfilled-clip");
    expect(bg.displayName).toBe("Background clip (fill me)");
    expect(m.audioClips).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/update_overlay/);
    expect(r.warnings.join("\n")).toMatch(/audio_add_clip/);
  });

  it("fetches https slot values through fetchUrls, once, and refuses http:", async () => {
    const dst = seedPiece(testDb, { id: "dst4" });
    fs.mkdirSync(path.join(storageDir, dst), { recursive: true });
    fs.writeFileSync(path.join(storageDir, dst, "fetched.mp4"), "fetched");
    testDb.insert(files).values({ id: "fetched", pieceId: dst, filename: "fetched.mp4", name: "fetched", description: "", type: "video", storagePath: `${dst}/fetched.mp4`, contentType: "video/mp4", size: 7 }).run();
    const fetchUrls = vi.fn<UrlFetcher>(async (urls) => urls.map((url) => ({ url, fileId: "fetched" })));

    const r = await applyScaffold({
      templateId,
      pieceId: dst,
      slotValues: { headline: "x", clip: "https://cdn.example.com/clip.mp4", song: "https://cdn.example.com/song.mp3" },
      fetchUrls,
    });
    expect(fetchUrls).toHaveBeenCalledTimes(1);
    expect(fetchUrls.mock.calls[0][0]).toEqual(["https://cdn.example.com/clip.mp4", "https://cdn.example.com/song.mp3"]);
    const m = await loadManifest(dst);
    expect((m.overlays!.find((o) => o.id === r.overlays.background) as { fileId: string }).fileId).toBe("fetched");
    expect(m.audioClips!.find((c) => c.id === r.clips.music)!.fileId).toBe("fetched");

    const r2 = await applyScaffold({
      templateId,
      pieceId: dst,
      mode: "replace",
      slotValues: { headline: "x", clip: "http://cdn.example.com/clip.mp4" },
      fetchUrls,
    });
    expect(r2.unfilledSlots.map((s) => s.key)).toEqual(["clip", "song"]);
    expect(r2.warnings.join("\n")).toMatch(/https/);
  });

  it("reports a download failure as an unfilled slot rather than a broken overlay", async () => {
    const dst = seedPiece(testDb, { id: "dst4b" });
    const fetchUrls = vi.fn<UrlFetcher>(async (urls) => urls.map((url) => ({ url, error: "404" })));
    const r = await applyScaffold({
      templateId,
      pieceId: dst,
      slotValues: { headline: "x", clip: "https://cdn.example.com/clip.mp4" },
      fetchUrls,
    });
    expect(r.unfilledSlots.map((s) => s.key)).toEqual(["clip", "song"]);
    expect(r.warnings.join("\n")).toMatch(/download failed \(404\)/);
    const m = await loadManifest(dst);
    expect((m.overlays!.find((o) => o.id === r.overlays.background) as { fileId: string }).fileId).toBe("unfilled-clip");
  });

  // Follow-ups T7 fix round 1: slotValues take the same kind gate as add_overlay / update_overlay.
  it("a media slot refuses a file of another kind (in-piece or downloaded): unfilled + warning, never a failed apply", async () => {
    const dst = seedPiece(testDb, { id: "dst-kind" });
    const row = (id: string, filename: string, type: string, contentType: string) =>
      testDb.insert(files).values({ id, pieceId: dst, filename, name: filename, description: "", type, storagePath: `${dst}/${filename}`, contentType, size: 1 }).run();
    row("k-audio", "vo.mp3", "audio", "audio/mpeg");
    row("k-video", "take.mp4", "video", "video/mp4");
    row("k-image", "still.png", "image", "image/png");
    // libi.save_asset stores the agent's free-text type verbatim.
    row("k-saved-video", "gen.mp4", "video/generated", "video/mp4");
    row("k-saved-vo", "line.mp3", "audio/voiceover", "audio/mpeg");

    // An audio file on the video slot is refused; a video on the audio slot is fine (its sound track).
    const a = await applyScaffold({ templateId, pieceId: dst, slotValues: { headline: "x", clip: "k-audio", song: "k-video" }, fetchUrls: noUrls });
    expect(a.unfilledSlots.map((s) => s.key)).toEqual(["clip"]);
    expect(a.warnings.join("\n")).toContain(`slot "clip": "k-audio" is an audio file; this video slot needs a video file`);
    const m = await loadManifest(dst);
    expect((m.overlays!.find((o) => o.id === a.overlays.background) as { fileId: string }).fileId).toBe("unfilled-clip");
    expect(m.audioClips!.find((c) => c.id === a.clips.music)!.fileId).toBe("k-video");

    // An image on the audio slot is refused; a save_asset-typed video fills the video slot.
    const b = await applyScaffold({ templateId, pieceId: dst, mode: "replace", slotValues: { headline: "x", clip: "k-saved-video", song: "k-image" }, fetchUrls: noUrls });
    expect(b.unfilledSlots.map((s) => s.key)).toEqual(["song"]);
    expect(b.warnings.join("\n")).toContain(`slot "song": "k-image" is an image file; this audio slot needs an audio or video file`);

    // A save_asset-typed voiceover is audio: refused on the video slot.
    const c = await applyScaffold({ templateId, pieceId: dst, mode: "replace", slotValues: { headline: "x", clip: "k-saved-vo" }, fetchUrls: noUrls });
    expect(c.unfilledSlots.map((s) => s.key)).toEqual(["clip", "song"]);
    expect(c.warnings.join("\n")).toMatch(/slot "clip": "k-saved-vo" is an audio file/);

    // An https value is checked once the download is stored: an mp3 on the video slot is refused.
    const fetchUrls = vi.fn<UrlFetcher>(async (urls) => urls.map((url) => ({ url, fileId: url.endsWith(".mp3") ? "k-audio" : "k-video" })));
    const d = await applyScaffold({
      templateId, pieceId: dst, mode: "replace",
      slotValues: { headline: "x", clip: "https://cdn.example.com/oops.mp3", song: "https://cdn.example.com/song.mp4" },
      fetchUrls,
    });
    expect(d.unfilledSlots.map((s) => s.key)).toEqual(["clip"]);
    expect(d.warnings.join("\n")).toContain(`slot "clip": the download is an audio file; this video slot needs a video file`);
  });

  it("refuses a file id that belongs to another piece, and an unknown slot key", async () => {
    const dst = seedPiece(testDb, { id: "dst5" });
    const r = await applyScaffold({ templateId, pieceId: dst, slotValues: { headline: "x", clip: ids.videoFileId }, fetchUrls: noUrls });
    expect(r.unfilledSlots.map((s) => s.key)).toEqual(["clip", "song"]);
    expect(r.warnings.join("\n")).toMatch(/not a file of this piece/);
    await expect(applyScaffold({ templateId, pieceId: dst, slotValues: { ghost: "x" }, fetchUrls: noUrls })).rejects.toThrow(/slot_unknown: ghost/);
  });

  it("rejects a code body that fails the write-path validator", async () => {
    // Same gate `libi.add_overlay` applies to agent-written bodies (scene-validator.ts).
    fs.writeFileSync(path.join(templateDir(fullId), "overlays", "sparkle", "draw.jsx"), "fetch('http://127.0.0.1:1/api/pieces'); ctx.fillRect(0,0,1,1);");
    const dst = seedPiece(testDb, { id: "dst6" });
    await expect(applyScaffold({ templateId: fullId, pieceId: dst, fetchUrls: noUrls })).rejects.toThrow(
      /template_body_rejected: sparkle: .*disallowed pattern/,
    );
    // A rejected template leaves NOTHING behind — not an overlay, not a file.
    expect((await loadManifest(dst)).overlays ?? []).toEqual([]);
    expect(testDb.select().from(files).where(eq(files.pieceId, dst)).all()).toEqual([]);
  });

  describe("a template whose assets are hosted", () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    /** Hand-written rather than extracted: extract only ever emits `file`
     *  assets, so the `url` arm belongs to an imported or authored template. */
    function hostedScaffold(): TemplateScaffold {
      return {
        schema: 1,
        name: "Hosted",
        description: "",
        tags: [],
        canvas: { width: 1080, height: 1920, fps: 30 },
        duration: 4,
        slots: [{ key: "clip", kind: "video", label: "Clip", required: true }],
        overlays: [
          { key: "bg", kind: "video", startTime: 0, duration: 4, rect, z: 0, opacity: 1, source: { slot: "clip" } },
          { key: "title", kind: "text", startTime: 0, duration: 4, rect, z: 1, opacity: 1, text: { fixed: "Hi" }, font: "700 64px Brand", color: "#fff", align: "center", fontFileId: "brandfont" },
          { key: "badge", kind: "image", startTime: 0, duration: 4, rect, z: 2, opacity: 1, source: { assetRef: "badge" } },
        ] as TemplateScaffold["overlays"],
        audioClips: [],
        assets: [
          { ref: "badge", kind: "image", url: "https://cdn.example.com/badge.png" },
          { ref: "brandfont", kind: "font", url: "https://cdn.example.com/brand.ttf" },
        ],
        fonts: [{ family: "Brand", assetRef: "brandfont" }],
        // A BUNDLED style id: nothing to register, nothing to suffix.
        captionStyles: [{ id: "clean", fields: { color: "#fff" } }],
      };
    }

    let hostedId: string;
    beforeEach(async () => {
      hostedId = (
        await createTemplate({ name: "Hosted", description: "", tags: [], scaffold: hostedScaffold(), instructions: "", copies: [], writes: [] })
      ).id;
    });

    it("fetches hosted assets and slot urls in the SAME single call", async () => {
      const dst = seedPiece(testDb, { id: "dst8" });
      const fetchUrls = vi.fn<UrlFetcher>(async (urls) => urls.map((url, i) => ({ url, fileId: `got-${i}` })));
      const r = await applyScaffold({ templateId: hostedId, pieceId: dst, slotValues: { clip: "https://cdn.example.com/clip.mp4" }, fetchUrls });

      expect(fetchUrls).toHaveBeenCalledTimes(1);
      expect(fetchUrls.mock.calls[0][0]).toEqual([
        "https://cdn.example.com/badge.png",
        "https://cdn.example.com/brand.ttf",
        "https://cdn.example.com/clip.mp4",
      ]);
      expect(r.unfilledSlots).toEqual([]);
      const m = await loadManifest(dst);
      const byId = Object.fromEntries(m.overlays!.map((o) => [o.id, o]));
      expect((byId[r.overlays.badge] as { fileId: string }).fileId).toBe("got-0");
      expect((byId[r.overlays.bg] as { fileId: string }).fileId).toBe("got-2");
      const title = byId[r.overlays.title];
      expect(title.kind === "text" && title.fontFileId).toBe("got-1");
      expect(title.kind === "text" && title.font).toBe("700 64px libifont-got-1, sans-serif");
      // A bundled caption style is offered under its own id, never re-registered.
      expect(r.warnings.join("\n")).toContain("caption styles available: clean");
      expect(await getUserPreset(`clean-${hostedId.slice(0, 8)}`)).toBeNull();
    });

    it("asks for one download when an asset and a slot name the same url", async () => {
      const dst = seedPiece(testDb, { id: "dst8b" });
      const fetchUrls = vi.fn<UrlFetcher>(async (urls) => urls.map((url) => ({ url, fileId: "shared" })));
      const r = await applyScaffold({ templateId: hostedId, pieceId: dst, slotValues: { clip: "https://cdn.example.com/badge.png" }, fetchUrls });
      expect(fetchUrls.mock.calls[0][0]).toEqual(["https://cdn.example.com/badge.png", "https://cdn.example.com/brand.ttf"]);
      const m = await loadManifest(dst);
      expect((m.overlays!.find((o) => o.id === r.overlays.bg) as { fileId: string }).fileId).toBe("shared");
    });

    it("skips a layer whose hosted asset never arrived and leaves the text in a fallback face", async () => {
      const dst = seedPiece(testDb, { id: "dst9" });
      const fetchUrls = vi.fn<UrlFetcher>(async (urls) => urls.map((url) => ({ url, error: "offline" })));
      const r = await applyScaffold({ templateId: hostedId, pieceId: dst, slotValues: { clip: "https://cdn.example.com/clip.mp4" }, fetchUrls });

      expect(Object.keys(r.overlays).sort()).toEqual(["bg", "title"]);
      expect(r.unfilledSlots.map((s) => s.key)).toEqual(["clip"]);
      const joined = r.warnings.join("\n");
      expect(joined).toMatch(/asset "badge" could not be fetched \(offline\)/);
      expect(joined).toMatch(/"badge" skipped: asset "badge" is unavailable/);
      expect(joined).toMatch(/font "Brand" was not available/);

      const m = await loadManifest(dst);
      const title = m.overlays!.find((o) => o.id === r.overlays.title)!;
      expect(title.kind === "text" && title.fontFileId).toBeUndefined();
      expect(title.kind === "text" && title.font).toBe("700 64px Brand");
      expect((m.overlays!.find((o) => o.id === r.overlays.bg) as { fileId: string }).fileId).toBe("unfilled-clip");
    });
  });

  it("refuses a broken template, an unknown template and a missing piece", async () => {
    const dst = seedPiece(testDb, { id: "dst7" });
    await expect(applyScaffold({ templateId: fullId, pieceId: "ghost", fetchUrls: noUrls })).rejects.toThrow(/piece_not_found/);
    await expect(applyScaffold({ templateId: "nope", pieceId: dst, fetchUrls: noUrls })).rejects.toThrow(/template_not_found/);
    fs.writeFileSync(path.join(templateDir(fullId), "template.json"), "{}");
    await expect(applyScaffold({ templateId: fullId, pieceId: dst, fetchUrls: noUrls })).rejects.toThrow(/template_broken/);
  });

  /** Rewrite the stored template.json in place, as a hostile author would. */
  function editScaffold(id: string, mutate: (raw: Record<string, unknown> & { overlays: Array<Record<string, unknown>>; assets: Array<Record<string, unknown>>; captionStyles: Array<Record<string, unknown>> }) => void) {
    const p = path.join(templateDir(id), "template.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    mutate(raw);
    fs.writeFileSync(p, JSON.stringify(raw));
  }

  // Final review I1(b): the asset's free-text `contentType` became the stored
  // row's type, and `/api/files/by-id/:id/content` served it verbatim — an HTML
  // page in libi's origin.
  it("stores an asset under the type its extension and kind allow, never the scaffold's contentType", async () => {
    editScaffold(fullId, (raw) => {
      for (const a of raw.assets) a.contentType = "text/html";
    });
    const dst = seedPiece(testDb, { id: "dst-ct" });
    const r = await applyScaffold({ templateId: fullId, pieceId: dst, fetchUrls: noUrls });
    const out = await loadManifest(dst);
    const logo = out.overlays!.find((o) => o.id === r.overlays.logo) as { fileId: string };
    const rows = testDb.select().from(files).where(eq(files.pieceId, dst)).all();
    expect(rows.find((f) => f.id === logo.fileId)!.contentType).toBe("image/png");
    expect(rows.map((f) => f.contentType).sort()).toEqual(["audio/mpeg", "font/ttf", "image/png", "video/mp4"]);
  });

  // Final review I2: caption-style fields were registered as a user preset
  // verbatim, and applying it turned the text overlay into a three overlay
  // whose body never met the validator.
  it("a hostile caption style registers only its look, and applying it leaves the headline a text overlay", async () => {
    editScaffold(fullId, (raw) => {
      raw.captionStyles = [
        { id: "neon", fields: { kind: "three", id: "x", sceneFunction: "fetch('/api/pieces'); return () => {};", color: "#0ff" } },
      ];
    });
    const dst = seedPiece(testDb, { id: "dst-cs" });
    const r = await applyScaffold({ templateId: fullId, pieceId: dst, fetchUrls: noUrls });
    const presetId = `neon-${fullId.slice(0, 8)}`;
    expect(r.warnings.join("\n")).toContain(`caption styles available: ${presetId}`);
    expect((await getUserPreset(presetId))?.fields).toEqual({ color: "#0ff" });

    const applied = await applyOverlayPreset({ pieceId: dst, overlayId: r.overlays.headline, presetId });
    expect(applied.success).toBe(true);
    const headline = (await loadManifest(dst)).overlays!.find((o) => o.id === r.overlays.headline) as Record<string, unknown>;
    expect(headline.kind).toBe("text");
    expect(headline).not.toHaveProperty("sceneFunction");
    expect(headline.color).toBe("#0ff");
  });

  // Final review I4: `.passthrough()` let every unknown key, libi's runtime
  // markers included, land in composition.json.
  it("drops unknown fields and internal markers a template.json carries", async () => {
    editScaffold(fullId, (raw) => {
      for (const o of raw.overlays) Object.assign(o, { unfilledSlot: "clip", missing: true, version: 1e9, videoUrl: "/evil", bogus: 1 });
    });
    const dst = seedPiece(testDb, { id: "dst-markers" });
    await applyScaffold({ templateId: fullId, pieceId: dst, fetchUrls: noUrls });
    for (const o of (await loadManifest(dst)).overlays!) {
      for (const k of ["unfilledSlot", "missing", "videoUrl", "bogus"]) expect(o, `${o.id}.${k}`).not.toHaveProperty(k);
      expect((o as { version?: number }).version ?? 0).toBeLessThan(100);
    }
  });

  // I4's other half: the allowlist must not cost a legitimate field. Every
  // per-kind field the editor persists survives extract → apply.
  it("round-trips the per-kind fields the allowlist admits", async () => {
    const m = await loadManifest(srcPieceId);
    const byId = Object.fromEntries(m.overlays!.map((o) => [o.id, o as Record<string, unknown>]));
    Object.assign(byId[ids.text], {
      anchor: "bottom-center",
      maxWidthPct: 0.8,
      position: { x: 540, y: 1700 },
      reveal: { mode: "typewriter", fraction: 0.5 },
      stroke: { color: "#000", width: 4 },
      effects: { in: { effectId: "fade-in", durationMs: 300 } },
      keyframes: { opacity: { keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1, easing: "ease-in" }] } },
      hidden: false,
      version: 7,
    });
    Object.assign(byId[ids.image], { flipH: true, transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0.5 } }, group: "brand" });
    Object.assign(byId[ids.video], { trim: { start: 0.5, end: 3.5 }, fit: "contain" });
    Object.assign(byId[ids.three], { scale: 1.5, cameraPreset: "ground" });
    await saveManifest(srcPieceId, m);

    const ex = await extractScaffold(srcPieceId);
    const tid = (
      await createTemplate({ name: "Rich", description: "d", tags: ["t"], scaffold: ex.scaffold, instructions: "", copies: ex.copies, writes: ex.writes })
    ).id;
    const dst = seedPiece(testDb, { id: "dst-rich" });
    const r = await applyScaffold({ templateId: tid, pieceId: dst, fetchUrls: noUrls });
    const out = await loadManifest(dst);
    expect(normalize(out.overlays!)).toEqual(normalize((await loadManifest(srcPieceId)).overlays!));
    const headline = out.overlays!.find((o) => o.id === r.overlays.headline) as Record<string, unknown>;
    expect(headline.anchor).toBe("bottom-center");
    expect(headline.effects).toEqual({ in: { effectId: "fade-in", durationMs: 300 } });
    // The source's save counter did not travel.
    expect(headline.version ?? 0).toBeLessThan(7);
  });
  // Final re-review 1, New breakage 2: an audio clip on a VIDEO file (detach
  // and duplicate keep the clip's `fileId`) made extract throw
  // `asset_type_unsupported`, because the audio kind allowed no video
  // extension. Spec rule: "an inline audio clip may reference a video asset".
  describe("an audio clip whose file is a video", () => {
    /** Extract `srcPieceId` (with `opts`), store it, apply it into a new piece. */
    async function roundTrip(opts: Parameters<typeof extractScaffold>[1], dstId: string) {
      const ex = await extractScaffold(srcPieceId, opts);
      const tid = (
        await createTemplate({ name: "Clip on video", description: "d", tags: ["t"], scaffold: ex.scaffold, instructions: "", copies: ex.copies, writes: ex.writes })
      ).id;
      const dst = seedPiece(testDb, { id: dstId });
      const r = await applyScaffold({ templateId: tid, pieceId: dst, fetchUrls: noUrls });
      return { ex, r, out: await loadManifest(dst) };
    }

    it("a detached clip (standalone, still remembering its video) extracts and applies", async () => {
      const m = await loadManifest(srcPieceId);
      const clipA = m.audioClips!.find((c) => c.id === ids.clipA)!;
      clipA.kind = "standalone";
      await saveManifest(srcPieceId, m);

      const { ex, r, out } = await roundTrip(undefined, "dst-detached");
      const src = ex.scaffold.audioClips.find((c) => c.key === "background-audio")!.source as { assetRef: string };
      const asset = ex.scaffold.assets.find((a) => a.ref === src.assetRef)!;
      expect(asset.kind).toBe("audio");
      expect(asset.file).toMatch(/\.mp4$/);
      const clip = out.audioClips!.find((c) => c.id === r.clips["background-audio"])!;
      expect(clip.kind).toBe("standalone");
      expect(clip.linkedOverlayId).toBe(r.overlays.background);
      const row = testDb.select().from(files).where(eq(files.id, clip.fileId)).get()!;
      expect(row.contentType).toBe("video/mp4");
      expect(normalizeClips(out.audioClips!)).toEqual(normalizeClips((await loadManifest(srcPieceId)).audioClips!));
    });

    it("a standalone clip on a video file whose overlay is not in the template extracts and applies", async () => {
      const m = await loadManifest(srcPieceId);
      const clipA = m.audioClips!.find((c) => c.id === ids.clipA)!;
      clipA.kind = "standalone";
      delete clipA.linkedOverlayId;
      await saveManifest(srcPieceId, m);

      const { ex, r, out } = await roundTrip({ overlayIds: [ids.text] }, "dst-standalone-video");
      expect(ex.scaffold.assets.filter((a) => a.kind === "video")).toEqual([]);
      const clip = out.audioClips!.find((c) => c.id === r.clips["background-audio"])!;
      expect(clip.kind).toBe("standalone");
      const row = testDb.select().from(files).where(eq(files.id, clip.fileId)).get()!;
      expect(row.contentType).toBe("video/mp4");
      expect(fs.readFileSync(path.join(storageDir, "dst-standalone-video", row.filename)).toString()).toBe("bytes-of-bg.mp4");
    });
  });
  // Final re-review 1: a layer whose file a template could not carry arrives
  // as an unfilled slot — the same placeholder a slotted layer gets.
  it("a layer whose file could not be carried applies as an unfilled slot", async () => {
    testDb.update(files).set({ filename: "photo.heic", contentType: "image/heic", storagePath: `${srcPieceId}/photo.heic` }).where(eq(files.id, ids.imageFileId)).run();
    fs.renameSync(path.join(storageDir, srcPieceId, "logo.png"), path.join(storageDir, srcPieceId, "photo.heic"));
    const ex = await extractScaffold(srcPieceId);
    const tid = (
      await createTemplate({ name: "Heic", description: "d", tags: ["t"], scaffold: ex.scaffold, instructions: "", copies: ex.copies, writes: ex.writes })
    ).id;
    const dst = seedPiece(testDb, { id: "dst-heic" });
    const r = await applyScaffold({ templateId: tid, pieceId: dst, fetchUrls: noUrls });
    expect(r.unfilledSlots.map((s) => [s.key, s.kind])).toEqual([["logo", "image"]]);
    const logo = (await loadManifest(dst)).overlays!.find((o) => o.id === r.overlays.logo) as { fileId: string };
    expect(logo.fileId).toBe("unfilled-logo");
    expect(r.warnings.some((w) => /slot "logo" is unfilled/.test(w))).toBe(true);
    expect(testDb.select().from(files).where(eq(files.pieceId, dst)).all().some((f) => f.filename.endsWith(".heic"))).toBe(false);
  });
  // Fix round 2, N1: every string a STRANGER's template can carry is decided
  // on (lib/templates/author-text.ts). This scaffold puts a marker in every
  // one of them — the coverage check below fails if the schema grows a string
  // this fixture does not exercise — and the marker may survive in the piece
  // only as on-screen text or a font family.
  describe("a stranger's template: its words reach the piece only as on-screen text and font families", () => {
    const Z = "zzauthor";
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    const kf = (value: unknown, easing: string) => ({ keyframes: [{ t: 0, value, easing }, { t: 1, value, easing: "ease-in" }] });
    function strangerScaffold(): TemplateScaffold {
      return {
        schema: 1,
        name: `${Z} name`,
        description: `${Z} description`,
        tags: [`${Z}-tag`],
        canvas: { width: 1080, height: 1920, fps: 30, aspectRatioId: Z },
        duration: 4,
        slots: [
          { key: `${Z}-clip`, kind: "video", label: `${Z} clip label`, hint: `${Z} hint`, required: true },
          { key: `${Z}-line`, kind: "text", label: `${Z} line label`, required: false },
          { key: `${Z}-voice`, kind: "audio", label: `${Z} voice`, required: false },
        ],
        overlays: [
          {
            key: `${Z}-bg`, kind: "video", startTime: 0, duration: 4, rect, z: 0, opacity: 1, source: { slot: `${Z}-clip` },
            displayName: `${Z} layer`, group: `${Z} group`,
            effects: {
              in: { effectId: "slide", durationMs: 300, params: { direction: "left", [`${Z} key`]: 1 } },
              out: { effectId: `${Z}-effect`, params: { x: Z } },
              loop: { effectId: "bounce", params: { direction: Z } },
            },
            keyframes: {
              rect: kf(rect, "cubic-bezier(0.1, 0.2, 0.3, 0.4)"),
              opacity: kf(1, `${Z} easing`),
              transform3d: kf({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }, Z),
            },
          },
          {
            key: `${Z}-title`, kind: "text", startTime: 0, duration: 4, rect, z: 1, opacity: 1, text: { fixed: `${Z} on screen` },
            font: `700 64px ${Z}font`, fontFamily: `${Z}family`, color: Z, align: "center", fontFileId: `${Z}-font`, fontWeight: Z,
            highlightColor: Z, stroke: { color: Z, width: 2 }, shadow: { color: "rgba(0, 0, 0, 0.5)", blur: 4 }, background: { color: Z },
            reveal: { mode: Z, highlightColor: "#fff" },
            threeD: { depth: 1, frontColor: Z, sideColor: "red", lighting: Z, tilt: Z },
            group: "captions", displayName: `${Z} title`,
          },
          {
            key: `${Z}-line`, kind: "text", startTime: 0, duration: 4, rect, z: 2, opacity: 1, text: { slot: `${Z}-line` },
            font: "700 64px Inter", color: "#fff", align: "left", fontWeight: "bold", reveal: { mode: "typewriter", highlightColor: Z }, group: `${Z} group`,
          },
          { key: `${Z}-badge`, kind: "image", startTime: 0, duration: 4, rect, z: 3, opacity: 1, source: { assetRef: `${Z}-badge` }, group: `${Z} other group` },
          { key: `${Z}-logo`, kind: "image", startTime: 0, duration: 4, rect, z: 4, opacity: 1, source: { assetRef: `${Z}-logo` } },
          { key: `${Z}-vid`, kind: "video", startTime: 0, duration: 4, rect, z: 5, opacity: 1, source: { assetRef: `${Z}-vidasset` } },
          { key: `${Z}-fx`, kind: "code", startTime: 0, duration: 4, rect, z: 6, opacity: 1, codeFile: `overlays/${Z}-fx/draw.jsx` },
        ] as TemplateScaffold["overlays"],
        audioClips: [
          {
            key: `${Z}-music`, kind: "standalone", startTime: 0, duration: 4, trimStart: 0, volume: 1, enabled: true, label: `${Z} music`,
            source: { assetRef: `${Z}-song` },
            effects: {
              in: { effectId: "audio-fade-in", durationMs: 500, params: { [Z]: Z } },
              out: { effectId: "audio-fade-out", params: { [Z]: 1, b: Z } },
              loop: { effectId: `${Z}-loop`, params: { a: Z } },
            },
            duck: { sidechainClipIds: [`${Z}-inline`], thresholdDb: -30, ratio: 4, attackMs: 10, releaseMs: 200, reductionDb: 12 },
          },
          { key: `${Z}-inline`, kind: "inline", startTime: 0, duration: 4, trimStart: 0, volume: 1, enabled: true, linkedOverlayId: `${Z}-vid`, source: { assetRef: `${Z}-vidasset` }, label: `${Z} inline` },
          { key: `${Z}-vo`, kind: "standalone", startTime: 0, duration: 4, trimStart: 0, volume: 1, enabled: true, source: { slot: `${Z}-voice` } },
        ] as TemplateScaffold["audioClips"],
        assets: [
          { ref: `${Z}-badge`, kind: "image", url: `https://cdn.example.com/${Z}/${Z}-badge.png` },
          { ref: `${Z}-font`, kind: "font", url: `https://cdn.example.com/${Z}.ttf` },
          { ref: `${Z}-song`, kind: "audio", url: `https://cdn.example.com/${Z}-song.mp3` },
          { ref: `${Z}-vidasset`, kind: "video", url: `https://cdn.example.com/${Z}?name=${Z}.mp4` },
          { ref: `${Z}-logo`, kind: "image", file: `assets/${Z}-logo.png`, contentType: Z, sha256: "0".repeat(64) },
        ],
        fonts: [{ family: `${Z} Family`, assetRef: `${Z}-font` }],
        captionStyles: [
          {
            id: `${Z}-style`,
            fields: {
              color: Z, highlightColor: "#abc", fontFamily: `${Z}family`, fontWeight: Z, stroke: { color: Z, width: 1 },
              shadow: { color: "#000", blur: 1 }, background: { color: "navy" }, reveal: { mode: "pop", highlightColor: Z },
            },
          },
        ],
      };
    }

    /**
     * The stranger scaffold plus a layer, a clip and a caption style that carry
     * the marker where `strangerScaffold` holds a value the renderer knows (so
     * the test above can prove such values survive): together, the marker sits
     * at EVERY string path the schema admits.
     */
    function everyPathMarked(): TemplateScaffold {
      const s = strangerScaffold();
      s.overlays.push({
        key: `${Z}-marked`, kind: "text", startTime: 0, duration: 4, rect, z: 7, opacity: 1, text: { fixed: `${Z} words` },
        font: "700 64px Inter", color: "#fff", align: "left", shadow: { color: Z, blur: 1 }, threeD: { depth: 1, sideColor: Z },
        effects: { in: { effectId: Z, params: { a: Z } }, out: { effectId: "fade", params: { [Z]: 1 } }, loop: { effectId: Z, params: { [Z]: 1 } } },
        keyframes: { rect: kf(rect, Z) },
      } as TemplateScaffold["overlays"][number]);
      s.audioClips.push({
        key: `${Z}-marked-clip`, kind: "standalone", startTime: 0, duration: 4, trimStart: 0, volume: 1, enabled: true, source: { assetRef: `${Z}-song` },
        effects: { in: { effectId: Z }, out: { effectId: Z }, loop: { effectId: "audio-fade-in", params: { [Z]: 1 } } },
      } as TemplateScaffold["audioClips"][number]);
      s.captionStyles.push({ id: `${Z}-style2`, fields: { highlightColor: Z, shadow: { color: Z, blur: 1 }, background: { color: Z }, reveal: { mode: Z } } } as TemplateScaffold["captionStyles"][number]);
      return s;
    }
    /** String paths whose schema admits no words at all, so no marker can sit there. */
    const CANNOT_CARRY_WORDS = ["assets.*.sha256"]; // ^[0-9a-f]{64}$

    /** Every string in `v`, by path pattern (`*` an index; a record's key and value as `<key>` / `<entry>`). */
    function stringPaths(v: unknown, at: string[] = [], out = new Map<string, string[]>()): Map<string, string[]> {
      const add = (p: string[], s: string) => out.set(p.join("."), [...(out.get(p.join(".")) ?? []), s]);
      if (typeof v === "string") add(at, v);
      else if (Array.isArray(v)) v.forEach((x) => stringPaths(x, [...at, "*"], out));
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (at.at(-1) === "params") {
            add([...at, "<key>"], k);
            stringPaths(x, [...at, "<entry>"], out);
          } else stringPaths(x, [...at, k], out);
        }
      }
      return out;
    }
    const marked = (v: unknown) => [...stringPaths(v)].filter(([, ss]) => ss.some((s) => s.toLowerCase().includes(Z))).map(([p]) => p).sort();

    it("exercises every string the schema admits", async () => {
      const { validateScaffold, walkScaffoldSchema } = await import("@/lib/templates/scaffold");
      const v = validateScaffold(everyPathMarked());
      expect(v.ok, v.ok ? "" : v.reason).toBe(true);
      // A9 (A8 follow-up d): the MARKER at each path, not merely some string —
      // a path holding only a clean value proves nothing about what the apply
      // does with an author's words there.
      const carriesMarker = new Set([...marked(v.ok ? v.scaffold : null), ...CANNOT_CARRY_WORDS]);
      expect(walkScaffoldSchema().strings.filter((p) => !carriesMarker.has(p))).toEqual([]);
      expect(stringPaths(v.ok ? v.scaffold : null).get("assets.*.sha256")).toEqual(["0".repeat(64)]);
    });

    it("with the marker at every path, it still reaches the piece only as on-screen text and font families", async () => {
      const { listUserPresets } = await import("@/lib/overlays/preset-store");
      const tid = (
        await createTemplate({
          name: "Stranger", description: "", tags: [], origin: "installed", cloudId: "bcdefghijklmnopqrst2", scaffold: everyPathMarked(), instructions: "",
          copies: [{ rel: `assets/${Z}-logo.png`, from: path.join(storageDir, srcPieceId, "logo.png") }],
          writes: [{ rel: `overlays/${Z}-fx/draw.jsx`, body: "const { ctx } = context;\nctx.fillRect(0, 0, 10, 10);" }],
        })
      ).id;
      const dst = seedPiece(testDb, { id: "dst-every-path" });
      const fetchUrls = vi.fn<UrlFetcher>(async (urls) => urls.map((url, i) => ({ url, fileId: `got-${i}` })));
      const r = await applyScaffold({ templateId: tid, pieceId: dst, fetchUrls });
      expect(r.overlays[`${Z}-marked`]).toBeDefined();
      expect(r.clips[`${Z}-marked-clip`]).toBeDefined();
      expect(marked(await loadManifest(dst))).toEqual(["overlays.*.content", "overlays.*.fontFamily"]);
      const presets = (await listUserPresets()).filter((p) => p.id.startsWith(`template-${tid.slice(0, 8)}`));
      expect(presets).toHaveLength(2);
      expect(marked(presets)).toEqual(["*.fields.fontFamily"]);
      expect(r.leftOut.filter((l) => l.includes(Z))).toEqual([]);
      expect(testDb.select().from(files).where(eq(files.pieceId, dst)).all().map((f) => `${f.filename} ${f.name} ${f.description}`).join("\n")).not.toContain(Z);
    });

    it("applies with names libi makes up, style values the renderer knows, and no author text but what shows and the typeface", async () => {
      const { templates: templatesTable } = await import("@/lib/db/schema/sqlite");
      const { listUserPresets } = await import("@/lib/overlays/preset-store");
      const tid = (
        await createTemplate({
          name: "Stranger", description: "", tags: [], origin: "installed", cloudId: "abcdefghijklmnopqrst", scaffold: strangerScaffold(), instructions: "",
          copies: [{ rel: `assets/${Z}-logo.png`, from: path.join(storageDir, srcPieceId, "logo.png") }],
          writes: [{ rel: `overlays/${Z}-fx/draw.jsx`, body: "const { ctx } = context;\nctx.fillRect(0, 0, 10, 10);" }],
        })
      ).id;
      expect(testDb.select().from(templatesTable).where(eq(templatesTable.id, tid)).get()?.origin).toBe("installed");
      const dst = seedPiece(testDb, { id: "dst-stranger" });
      const fetchUrls = vi.fn<UrlFetcher>(async (urls) => urls.map((url, i) => ({ url, fileId: `got-${i}` })));
      const r = await applyScaffold({ templateId: tid, pieceId: dst, fetchUrls });

      // Hosted files are stored under libi's names, never the url's.
      expect(fetchUrls.mock.calls[0][1]).toEqual({
        [`https://cdn.example.com/${Z}/${Z}-badge.png`]: "template-asset-1.png",
        [`https://cdn.example.com/${Z}.ttf`]: "template-asset-2.ttf",
        [`https://cdn.example.com/${Z}-song.mp3`]: "template-asset-3.mp3",
        // The url's path has no allowed extension: no extension is invented.
        [`https://cdn.example.com/${Z}?name=${Z}.mp4`]: "template-asset-4",
      });

      const m = await loadManifest(dst);
      // The marker survives only where the template shows it: the on-screen text and the typeface.
      expect(marked(m)).toEqual(["overlays.*.content", "overlays.*.fontFamily"]);
      const pieceFiles = testDb.select().from(files).where(eq(files.pieceId, dst)).all();
      expect(pieceFiles.map((f) => [f.filename, f.name])).toEqual([["template-asset-5.png", "template-asset-5.png"]]);
      const presets = (await listUserPresets()).filter((p) => p.id.startsWith(`template-${tid.slice(0, 8)}`));
      expect(presets).toHaveLength(1);
      expect(marked(presets)).toEqual(["*.fields.fontFamily"]);

      const byKey = (k: string) => m.overlays!.find((o) => o.id === r.overlays[`${Z}-${k}`]) as unknown as Record<string, unknown>;
      // Groups keep their grouping under libi's names; a lane libi names stays.
      expect([byKey("bg").group, byKey("line").group, byKey("badge").group, byKey("title").group]).toEqual([
        "template-group-1", "template-group-1", "template-group-2", "captions",
      ]);
      // Values the renderer knows survive; the rest are left out.
      expect(byKey("bg").effects).toEqual({ in: { effectId: "slide", durationMs: 300, params: { direction: "left" } }, loop: { effectId: "bounce", params: {} } });
      const tracks = byKey("bg").keyframes as Record<string, { keyframes: Array<{ easing?: string }> }>;
      expect(tracks.rect.keyframes.map((k) => k.easing)).toEqual(["cubic-bezier(0.1, 0.2, 0.3, 0.4)", "ease-in"]);
      expect(tracks.opacity.keyframes.map((k) => k.easing)).toEqual([undefined, "ease-in"]);
      const title = byKey("title");
      expect(title.color).toBe("#ffffff");
      expect(title.shadow).toEqual({ color: "rgba(0, 0, 0, 0.5)", blur: 4 });
      for (const gone of ["highlightColor", "fontWeight", "stroke", "background", "reveal", "displayName"]) expect(title, gone).not.toHaveProperty(gone);
      expect(title.threeD).toEqual({ depth: 1, sideColor: "red" });
      expect(byKey("line").reveal).toEqual({ mode: "typewriter" });
      expect(byKey("line").fontWeight).toBe("bold");
      // An unfilled slot is named by its position, never its key or label.
      expect([byKey("bg").displayName, byKey("bg").fileId]).toEqual(["Slot 1 (fill me)", "unfilled-slot-1"]);
      expect(byKey("line").content).toBe("Slot 2 (fill me)");
      const music = m.audioClips!.find((c) => c.id === r.clips[`${Z}-music`]) as unknown as Record<string, unknown>;
      expect(music.effects).toEqual({ in: { effectId: "audio-fade-in", durationMs: 500, params: {} }, out: { effectId: "audio-fade-out", params: {} } });
      expect(m.audioClips!.every((c) => !("label" in c))).toBe(true);
      // Fix round 3: each thing left out is listed by where it was and what kind it was — never by the author's value.
      // A9 (A8 follow-up b): a layer or clip is named by the id libi minted for it too, which the timeline shows.
      const L = (n: number) => `layer ${n} (${r.overlays[strangerScaffold().overlays[n - 1].key]})`;
      const A = (n: number) => `audio clip ${n} (${r.clips[strangerScaffold().audioClips[n - 1].key]})`;
      expect(r.overlays[strangerScaffold().overlays[0].key]).toMatch(/^[a-z]+-[a-z0-9]+$/);
      expect(r.leftOut).toEqual([
        `${L(1)}: entrance effect setting not recognised`,
        `${L(1)}: exit effect not available`,
        `${L(1)}: loop effect setting not recognised`,
        `${L(1)}: animation easing not recognised (plays linear)`,
        `${L(2)}: colour not recognised`,
        `${L(2)}: highlight colour not recognised`,
        `${L(2)}: font weight not recognised`,
        `${L(2)}: outline not recognised`,
        `${L(2)}: background not recognised`,
        `${L(2)}: text reveal not available`,
        `${L(2)}: 3D colour not recognised`,
        `${L(2)}: 3D lighting not available`,
        `${L(2)}: 3D tilt not available`,
        `${L(3)}: reveal highlight colour not recognised`,
        `${A(1)}: entrance effect setting not recognised`,
        `${A(1)}: exit effect setting not recognised`,
        `${A(1)}: loop effect not available`,
        "caption style 1: colour not recognised",
        "caption style 1: font weight not recognised",
        "caption style 1: outline not recognised",
        "caption style 1: reveal highlight colour not recognised",
      ]);
      expect(r.leftOut.join("\n")).not.toContain(Z);
      expect(r.warnings.join("\n")).not.toMatch(/left out/);

      // Fix round 3, NEW-2: a replace retried after a timeout stores no second copy of the template's files.
      const again = await applyScaffold({ templateId: tid, pieceId: dst, fetchUrls, mode: "replace" });
      // The same list, naming the layers the replace minted.
      const unnamed = (lines: string[]) => lines.map((l) => l.replace(/ \([a-z0-9_-]+\):/, ":"));
      expect(unnamed(again.leftOut)).toEqual(unnamed(r.leftOut));
      expect(again.leftOut[0]).toContain(`(${again.overlays[strangerScaffold().overlays[0].key]})`);
      expect(testDb.select().from(files).where(eq(files.pieceId, dst)).all().map((f) => f.id)).toEqual(pieceFiles.map((f) => f.id));
    });

    it("the user's own template keeps its names and values", async () => {
      const tid = (
        await createTemplate({
          name: "Mine", description: "", tags: [], scaffold: strangerScaffold(), instructions: "",
          copies: [{ rel: `assets/${Z}-logo.png`, from: path.join(storageDir, srcPieceId, "logo.png") }],
          writes: [{ rel: `overlays/${Z}-fx/draw.jsx`, body: "const { ctx } = context;\nctx.fillRect(0, 0, 10, 10);" }],
        })
      ).id;
      const dst = seedPiece(testDb, { id: "dst-mine" });
      const fetchUrls = vi.fn<UrlFetcher>(async (urls) => urls.map((url, i) => ({ url, fileId: `got-${i}` })));
      const r = await applyScaffold({ templateId: tid, pieceId: dst, fetchUrls });
      expect(fetchUrls.mock.calls[0]).toHaveLength(1);
      const m = await loadManifest(dst);
      const bg = m.overlays!.find((o) => o.id === r.overlays[`${Z}-bg`]) as unknown as Record<string, unknown>;
      expect([bg.group, bg.displayName]).toEqual([`${Z} group`, `${Z} clip label (fill me)`]);
      expect(m.audioClips!.find((c) => c.id === r.clips[`${Z}-music`])?.label).toBe(`${Z} music`);
      expect(r.leftOut).toEqual([]);
    });
  });
});
