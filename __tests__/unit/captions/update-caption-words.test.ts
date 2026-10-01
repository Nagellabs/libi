/**
 * AUD-2 — editing a caption's TEXT keeps `caption.words` honest.
 *
 * A karaoke / word-by-word caption reveals word i of `caption.words` at its
 * own timing. `update_overlay {content}` used to change the text and leave the
 * old words in place, so the reveal highlighted words the caption no longer
 * says. Now:
 *   - same token count → the timings stay, the words are replaced;
 *   - different count  → the new tokens are spread proportionally over the old
 *     span, and the result says so (run generate_captions for exact sync).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlayToManifest, loadManifest, type PersistedOverlay } from "@/lib/composition/persistence";

let testDb: ReturnType<typeof createTestDb>;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

import { updateOverlay } from "@/mcp/tools/overlay-tools";

const PIECE = "p1";
const RESPREAD_NOTE =
  "The edited caption has different words, so its word timings were spread over the cue to fit them; " +
  "the highlight may run slightly off the speech. The edit is kept (re-running generate_captions would replace it).";
const WORDS = [
  { text: "Hello", start: 0.15, end: 0.55 },
  { text: "there", start: 0.65, end: 1.05 },
  { text: "world", start: 1.15, end: 1.65 },
];

async function seedCaption(extra: Partial<PersistedOverlay> = {}) {
  await addOverlayToManifest(PIECE, {
    id: "cue-1",
    kind: "text",
    content: "Hello there world",
    font: "48px Inter",
    color: "#fff",
    align: "center",
    rect: { x: 0, y: 0, width: 800, height: 80 },
    startTime: 2,
    duration: 2,
    z: 50,
    opacity: 1,
    reveal: { mode: "karaoke" },
    caption: { groupId: "cap-f1", styleRef: "karaoke", useTrackStyle: true, words: WORDS },
    ...extra,
  } as PersistedOverlay);
}

async function captionOf(id = "cue-1") {
  const o = ((await loadManifest(PIECE)).overlays ?? []).find((x) => x.id === id) as {
    content: string;
    caption?: { groupId: string; styleRef?: string; useTrackStyle: boolean; words?: typeof WORDS };
  };
  return o;
}

describe("update_overlay — a caption's text edit keeps caption.words in step", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
    testDb = createTestDb();
    seedPiece(testDb, { id: PIECE });
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("same token count: keeps every timing, replaces the words, no note", async () => {
    await seedCaption();
    const res = await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", content: "Hi  there, planet" });
    expect(res.success).toBe(true);
    expect((res.data as { note?: string }).note).toBeUndefined();
    const o = await captionOf();
    expect(o.content).toBe("Hi  there, planet");
    expect(o.caption?.words).toEqual([
      { text: "Hi", start: 0.15, end: 0.55 },
      { text: "there,", start: 0.65, end: 1.05 },
      { text: "planet", start: 1.15, end: 1.65 },
    ]);
    // The rest of the caption ref is untouched.
    expect(o.caption).toMatchObject({ groupId: "cap-f1", styleRef: "karaoke", useTrackStyle: true });
  });

  it("different count: spreads the new tokens proportionally over the old span and says so", async () => {
    await seedCaption();
    const res = await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", content: "Hi everyone" });
    expect(res.success).toBe(true);
    expect((res.data as { note?: string }).note).toBe(RESPREAD_NOTE);
    const words = (await captionOf()).caption!.words!;
    expect(words.map((w) => w.text)).toEqual(["Hi", "everyone"]);
    // Old span 0.15 → 1.65 (1.5 s), split by length: "Hi" 2/10, "everyone" 8/10.
    expect(words[0].start).toBeCloseTo(0.15, 3);
    expect(words[0].end).toBeCloseTo(0.45, 3);
    expect(words[1].start).toBeCloseTo(0.45, 3);
    expect(words[1].end).toBeCloseTo(1.65, 3);
  });

  it("more tokens than before: contiguous, ordered, inside the old span", async () => {
    await seedCaption();
    const res = await updateOverlay({
      pieceId: PIECE,
      overlayId: "cue-1",
      content: "Hello out there big wide world",
    });
    expect((res.data as { note?: string }).note).toBe(RESPREAD_NOTE);
    const words = (await captionOf()).caption!.words!;
    expect(words).toHaveLength(6);
    expect(words[0].start).toBeCloseTo(0.15, 3);
    expect(words[5].end).toBeCloseTo(1.65, 3);
    for (let i = 0; i < words.length; i++) {
      expect(words[i].end).toBeGreaterThan(words[i].start);
      if (i > 0) expect(words[i].start).toBeCloseTo(words[i - 1].end, 3);
    }
  });

  it("review m1: an added standalone emoji / dash keeps every word's own timing, no note", async () => {
    await seedCaption();
    const res = await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", content: "Hello – there world 🎉" });
    expect((res.data as { note?: string }).note).toBeUndefined();
    expect((await captionOf()).caption!.words).toEqual([
      { text: "Hello", start: 0.15, end: 0.55 },
      { text: "–", start: 0.15, end: 0.55 },
      { text: "there", start: 0.65, end: 1.05 },
      { text: "world", start: 1.15, end: 1.65 },
      { text: "🎉", start: 1.15, end: 1.65 },
    ]);
  });

  it("review m1: removing a standalone punctuation token keeps the words' timings", async () => {
    await seedCaption({
      content: "Hello — there world",
      caption: { groupId: "cap-f1", useTrackStyle: true, words: [WORDS[0], { text: "—", start: 0.55, end: 0.6 }, WORDS[1], WORDS[2]] },
    } as Partial<PersistedOverlay>);
    const res = await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", content: "Hello there world" });
    expect((res.data as { note?: string }).note).toBeUndefined();
    expect((await captionOf()).caption!.words).toEqual(WORDS);
  });

  it("review m2: committing the SAME text never re-times, even when the stored words never matched it", async () => {
    await seedCaption({
      content: "Hello there, world !",
      caption: { groupId: "cap-f1", useTrackStyle: true, words: WORDS },
    } as Partial<PersistedOverlay>);
    const res = await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", content: "Hello there, world !" });
    expect((res.data as { note?: string }).note).toBeUndefined();
    expect((await captionOf()).caption!.words).toEqual(WORDS);
  });

  it("a text overlay without caption.words is untouched (no words invented, no note)", async () => {
    await seedCaption({ id: "plain", caption: undefined });
    const res = await updateOverlay({ pieceId: PIECE, overlayId: "plain", content: "Two words" });
    expect((res.data as { note?: string }).note).toBeUndefined();
    const o = await captionOf("plain");
    expect(o.content).toBe("Two words");
    expect(o.caption).toBeUndefined();
  });

  it("a patch without content leaves the words alone", async () => {
    await seedCaption();
    await updateOverlay({ pieceId: PIECE, overlayId: "cue-1", opacity: 0.5 });
    expect((await captionOf()).caption?.words).toEqual(WORDS);
  });
});
