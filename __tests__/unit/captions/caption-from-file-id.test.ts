/**
 * NQ-1 — `update_overlay { captionFromFileId }` windows a file's words on the
 * piece TIMELINE, and a cue of a generated track stays in its track.
 *
 * Whisper stores SOURCE-file seconds. The overlay's window is on the TIMELINE,
 * so a clip placed at 2 s used to hand a cue the words spoken 2 s later in the
 * file (the agent re-split three cues and got them back 2 s early). And the
 * directive always wrote `cap-<fileId>-custom` / `useTrackStyle: false`, so a
 * re-split cue left its track and fell back to plain Inter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlayToManifest, loadManifest, saveManifest } from "@/lib/composition/persistence";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

const WORDS = [ // SOURCE-file seconds (what Whisper stores)
  { text: "And", start: 0.3, end: 0.5, type: "word" },
  { text: "so", start: 0.5, end: 0.7, type: "word" },
  { text: "my", start: 0.7, end: 0.9, type: "word" },
  { text: "fellow", start: 0.9, end: 1.3, type: "word" },
  { text: "Americans,", start: 1.3, end: 2.0, type: "word" },
  { text: "ask", start: 3.0, end: 3.3, type: "word" },
  { text: "not", start: 3.3, end: 3.6, type: "word" },
];
vi.mock("@/lib/analysis/manager", async (orig) => ({
  ...(await orig<typeof import("@/lib/analysis/manager")>()),
  getAnalysis: vi.fn(async () => ({ audioChunks: [{ chunkIndex: 0, words: JSON.stringify(WORDS) }] })),
}));

import { updateOverlay } from "@/mcp/tools/overlay-tools";
import { wordsOnTimeline } from "@/mcp/tools/caption-tools";
import type { SttWord } from "@/lib/analysis/types";

const PIECE = "p1";

// seed: the recording as a standalone clip at 2 s, and one cue of the generated track
async function seed(caption: Record<string, unknown>) {
  const m = await loadManifest(PIECE);
  m.audioClips = [{ id: "clip-1", kind: "standalone", fileId: "f1", startTime: 2, duration: 11,
    trimStart: 0, volume: 1, enabled: true } as never];
  await saveManifest(PIECE, m);
  await addOverlayToManifest(PIECE, { id: "cue-1", kind: "text", content: "And so my fellow Americans,",
    font: "90px Inter", color: "#fff", align: "center", rect: { x: 0, y: 0, width: 800, height: 200 },
    startTime: 2, duration: 2.2, z: 50, opacity: 1, caption } as never);
}

async function captionOf(id = "cue-1") {
  const o = ((await loadManifest(PIECE)).overlays ?? []).find((x) => x.id === id) as {
    caption?: {
      groupId: string;
      styleRef?: string;
      useTrackStyle: boolean;
      words?: Array<{ text: string; start: number; end: number }>;
    };
  };
  return o;
}

describe("update_overlay — captionFromFileId follows the timeline and keeps a track cue in its track", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("windows the words on the TIMELINE: a clip at 2 s gives this cue its own words, element-local", async () => {
    await seed({ groupId: "cap-f1", styleRef: "newsroom", useTrackStyle: true });
    const r = await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", captionFromFileId: "f1" });
    expect(r.success).toBe(true);
    const words = (await captionOf()).caption!.words!;
    expect(words.map((w) => w.text)).toEqual(["And", "so", "my", "fellow", "Americans,"]);
    expect(words[0]).toEqual({ text: "And", start: 0.3, end: 0.5 }); // timeline 2.3 − cue start 2
  });

  it("a cue of a generated track stays in it: group, style and useTrackStyle kept", async () => {
    await seed({ groupId: "cap-f1", styleRef: "newsroom", useTrackStyle: true });
    await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", content: "And so my fellow", startTime: 2, duration: 1.2, captionFromFileId: "f1" });
    const c = (await captionOf()).caption!;
    expect(c).toMatchObject({ groupId: "cap-f1", styleRef: "newsroom", useTrackStyle: true });
    // re-windowed to [2, 3.2) on the timeline: "Americans," (2 s + 1.3) is out
    expect(c.words!.map((w) => w.text)).toEqual(["And", "so", "my", "fellow"]);
  });

  it("an overlay outside any track still gets the custom group (code/three caption)", async () => {
    await seed(undefined as never); // no caption yet
    await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", captionFromFileId: "f1" });
    expect((await captionOf()).caption).toMatchObject({ groupId: "cap-f1-custom", useTrackStyle: false });
  });

  // Whisper's words are contiguous (end === next start). A re-split cue that
  // starts on a word's start, or ends on the next word's start, must not pick up
  // its neighbour: karaoke pairs caption.words[i] with the i-th content token.
  it("back-to-back words split at a shared boundary: each cue gets only its own words (half-open, by start)", async () => {
    await seed({ groupId: "cap-f1", styleRef: "newsroom", useTrackStyle: true });
    await addOverlayToManifest(PIECE, { id: "cue-2", kind: "text", content: "x", font: "90px Inter", color: "#fff",
      align: "center", rect: { x: 0, y: 0, width: 800, height: 200 }, startTime: 4.3, duration: 1,
      z: 50, opacity: 1, caption: { groupId: "cap-f1", styleRef: "newsroom", useTrackStyle: true } } as never);
    // "And so" ends on my.start (timeline 2.7); "my fellow Americans," starts there.
    const a = await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", content: "And so,", startTime: 2.3, duration: 0.4, captionFromFileId: "f1" });
    const b = await updateOverlay({ pieceId: PIECE, overlayId: "cue-2", content: "my fellow Americans,", startTime: 2.7, duration: 1.3, captionFromFileId: "f1" });
    expect((await captionOf("cue-1")).caption!.words).toEqual([
      { text: "And", start: 0, end: 0.2 },
      { text: "so,", start: 0.2, end: 0.4 },
    ]);
    expect((await captionOf("cue-2")).caption!.words).toEqual([
      { text: "my", start: 0, end: 0.2 },
      { text: "fellow", start: 0.2, end: 0.6 },
      { text: "Americans,", start: 0.6, end: 1.3 },
    ]);
    expect((a.data as { note?: string }).note).toBeUndefined();
    expect((b.data as { note?: string }).note).toBeUndefined();
  });

  it("a cue whose hold runs past the next word's start keeps only the words its text says", async () => {
    await seed({ groupId: "cap-f1", styleRef: "newsroom", useTrackStyle: true });
    // lead 0.15 s before "And" (2.3), hold to 3.05 — past "my" (2.7)
    const r = await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", content: "And so", startTime: 2.15, duration: 0.9, captionFromFileId: "f1" });
    expect((r.data as { note?: string }).note).toBeUndefined();
    expect((await captionOf()).caption!.words!.map((w) => w.text)).toEqual(["And", "so"]);
  });

  it("a text that doesn't match the words heard in the window: one word per token, and the result says so", async () => {
    await seed({ groupId: "cap-f1", styleRef: "newsroom", useTrackStyle: true });
    const r = await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", content: "And so, my dear fellow", startTime: 2.3, duration: 1, captionFromFileId: "f1" });
    expect(r.success).toBe(true);
    expect((r.data as { note?: string }).note).toMatch(/word timings were spread/);
    expect((await captionOf()).caption!.words!.map((w) => w.text)).toEqual(["And", "so,", "my", "dear", "fellow"]);
  });

  it("a NEW text cue with no caption joins the file's generated track and takes its look", async () => {
    await seed({ groupId: "cap-f1", styleRef: "newsroom", useTrackStyle: true });
    const m = await loadManifest(PIECE);
    const cue1 = m.overlays!.find((o) => o.id === "cue-1") as unknown as Record<string, unknown>;
    Object.assign(cue1, { color: "#ffcc00", fontSize: 90, stroke: { color: "#000", width: 4 },
      reveal: { mode: "karaoke" }, anchor: "bottom-center", position: { x: 540, y: 1800 }, maxWidthPct: 0.84 });
    await saveManifest(PIECE, m);
    // what add_overlay leaves: a plain default-looking text overlay, no caption
    await addOverlayToManifest(PIECE, { id: "cue-new", kind: "text", content: "ask not", font: "48px Inter",
      color: "#fff", align: "center", rect: { x: 0, y: 0, width: 400, height: 80 }, startTime: 4.85, duration: 0.8,
      z: 50, opacity: 1, background: { color: "#333" } } as never);
    const r = await updateOverlay({ pieceId: PIECE, overlayId: "cue-new", captionFromFileId: "f1" });
    expect(r.success).toBe(true);
    const o = (await loadManifest(PIECE)).overlays!.find((x) => x.id === "cue-new") as unknown as Record<string, unknown>;
    expect(o.caption).toMatchObject({ groupId: "cap-f1", styleRef: "newsroom", useTrackStyle: true });
    expect(o).toMatchObject({ color: "#ffcc00", fontSize: 90, stroke: { color: "#000", width: 4 },
      reveal: { mode: "karaoke" }, anchor: "bottom-center", position: { x: 540, y: 1800 }, maxWidthPct: 0.84 });
    expect(o.background).toBeUndefined(); // the track's look has none
    expect(o.content).toBe("ask not"); // its own text and timing stay
    expect(o.startTime).toBe(4.85);
  });

  it("a code overlay stays a custom caption even when the file has a track", async () => {
    await seed({ groupId: "cap-f1", styleRef: "newsroom", useTrackStyle: true });
    await addOverlayToManifest(PIECE, { id: "code-1", kind: "code", rect: { x: 0, y: 0, width: 800, height: 200 },
      startTime: 2, duration: 2.2, z: 60, opacity: 1 } as never);
    await updateOverlay({ pieceId: PIECE, overlayId: "code-1", captionFromFileId: "f1" });
    expect((await captionOf("code-1")).caption).toMatchObject({ groupId: "cap-f1-custom", useTrackStyle: false });
  });

  it("a trimmed clip: the words follow trimStart as well as startTime", async () => {
    await seed(undefined as never);
    const m = await loadManifest(PIECE);
    m.audioClips = [{ id: "clip-1", kind: "standalone", fileId: "f1", startTime: 2, duration: 5,
      trimStart: 1, volume: 1, enabled: true } as never];
    await saveManifest(PIECE, m);
    // source 1.3 ("Americans,") plays at timeline 2.3; "ask" (3.0) at 4.0
    await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", content: "Americans, ask not", startTime: 2.3, duration: 2.3, captionFromFileId: "f1" });
    expect((await captionOf()).caption!.words).toEqual([
      { text: "Americans,", start: 0, end: 0.7 },
      { text: "ask", start: 1.7, end: 2 },
      { text: "not", start: 2, end: 2.3 },
    ]);
  });

  it("a file muted everywhere on the timeline: refused, and the hint says it is muted", async () => {
    await seed(undefined as never);
    const m = await loadManifest(PIECE);
    (m.audioClips![0] as { volume: number }).volume = 0;
    await saveManifest(PIECE, m);
    const r = await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", captionFromFileId: "f1" });
    expect(r).toMatchObject({ success: false, error: "no_transcript_in_window" });
    expect((r.data as { hint: string }).hint).toMatch(/muted/);
  });

  it("a file with no window on the timeline keeps the old source-time windowing", async () => {
    await seed(undefined as never);
    const m = await loadManifest(PIECE);
    m.audioClips = []; // f1 is nowhere on the timeline
    await saveManifest(PIECE, m);
    // A code caption (inclusive overlap), so the source window is all that is tested here;
    // a text cue would further re-key the words to its own tokens.
    await addOverlayToManifest(PIECE, { id: "code-1", kind: "code", rect: { x: 0, y: 0, width: 800, height: 200 },
      startTime: 2, duration: 2.2, z: 60, opacity: 1 } as never);
    await updateOverlay({ pieceId: PIECE, overlayId: "code-1", captionFromFileId: "f1" });
    // source window [2, 4.2]: "Americans," (ends 2.0), "ask", "not" — unchanged behaviour
    expect((await captionOf("code-1")).caption!.words!.map((w) => w.text)).toEqual(["Americans,", "ask", "not"]);
  });
});

describe("wordsOnTimeline — a file's words moved to where it plays", () => {
  const words = WORDS.slice(0, 3) as SttWord[]; // And 0.3, so 0.5, my 0.7 (source)
  const clip = (over: Record<string, unknown>) =>
    ({ id: "c", kind: "standalone", fileId: "f1", startTime: 0, duration: 10, trimStart: 0, volume: 1, enabled: true, ...over }) as never;

  it("null when the file is nowhere on the timeline; [] when every window is muted", () => {
    expect(wordsOnTimeline(words, [], [], "f1")).toBeNull();
    expect(wordsOnTimeline(words, [], [clip({ volume: 0 })], "f1")).toEqual([]);
  });

  it("a video overlay with its coupled clip: shifted by startTime − trim.start", () => {
    const video = { id: "v1", kind: "video", fileId: "f1", startTime: 5, duration: 3, trim: { start: 0.5 },
      rect: { x: 0, y: 0, width: 1, height: 1 }, z: 0, opacity: 1 } as never;
    const inline = clip({ id: "i1", kind: "inline", linkedOverlayId: "v1", startTime: 5, duration: 3, trimStart: 0.5 });
    const out = wordsOnTimeline(words, [video], [inline], "f1")!;
    expect(out.map((x) => [x.text, x.start])).toEqual([["so", 5], ["my", 5.2]]); // "And" (0.3) is trimmed off
  });

  it("two clips of the same file: each plays its words at its own place, sorted", () => {
    const out = wordsOnTimeline(words, [], [clip({ id: "a", startTime: 0 }), clip({ id: "b", startTime: 20 })], "f1")!;
    expect(out.map((x) => x.start)).toEqual([0.3, 0.5, 0.7, 20.3, 20.5, 20.7]);
  });
});
