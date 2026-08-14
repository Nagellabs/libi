import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTempStorageDir, cleanupTempDir } from "../../helpers/test-storage";
import type { ElevenLabsWord } from "@/lib/elevenlabs/transcribe";

describe("generateCaptions — build a caption track from word timings", () => {
  afterEach(() => cleanupTempDir());

  async function setup() {
    vi.resetModules();
    createTempStorageDir();
    const { generateCaptions } = await import("@/mcp/tools/caption-tools");
    const { loadManifest, saveManifest } = await import("@/lib/composition/persistence");
    const { getLibiStorageDir } = await import("@/lib/libi-home");
    return { generateCaptions, loadManifest, saveManifest, getLibiStorageDir };
  }

  async function seedManifest(
    saveManifest: typeof import("@/lib/composition/persistence").saveManifest,
    getLibiStorageDir: () => string,
    pieceId: string,
    width: number,
    height: number,
  ) {
    fs.mkdirSync(path.join(getLibiStorageDir(), pieceId), { recursive: true });
    await saveManifest(pieceId, {
      sceneOrder: [],
      width,
      height,
      fps: 30,
      scenes: [],
      overlays: [],
    });
  }

  const words: ElevenLabsWord[] = [
    { text: "Hello", start: 0.0, end: 0.4, type: "word" },
    { text: "there", start: 0.5, end: 0.9, type: "word" },
    { text: "world", start: 1.0, end: 1.5, type: "word" },
  ];

  it("creates text overlays sharing one caption group, rect at bottom-center", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    const pieceId = "p1";
    const width = 1920;
    const height = 1080;
    await seedManifest(saveManifest, getLibiStorageDir, pieceId, width, height);

    const result = await generateCaptions(
      { pieceId, fileId: "f1" },
      { readWords: async () => words },
    );

    expect(result.success).toBe(true);
    expect(result.data!.cueCount as number).toBeGreaterThanOrEqual(1);
    const groupId = result.data!.captionGroupId as string;

    const manifest = await loadManifest(pieceId);
    const overlays = manifest.overlays ?? [];
    expect(overlays.length).toBe(result.data!.cueCount);

    for (const o of overlays) {
      expect(o.kind).toBe("text");
      expect((o as { caption?: { groupId: string } }).caption?.groupId).toBe(groupId);
    }

    // Point-text model: the derived rect hugs the text, horizontally centered
    // and sitting in the bottom safe band — never cut off past the canvas bottom.
    const rect = (overlays[0] as { rect: { x: number; y: number; width: number; height: number } }).rect;
    expect(rect.x + rect.width / 2).toBeCloseTo(width / 2, 0); // centered
    expect(rect.y).toBeGreaterThan(height * 0.7); // lower third
    expect(rect.y + rect.height).toBeLessThanOrEqual(height); // not overflowing the bottom
    expect(rect.y + rect.height).toBeGreaterThan(height * 0.8); // actually near the bottom
  });

  it("sets a reveal mode per style (karaoke/cumulative/word-by-word/letter-by-letter)", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    const cases: Array<[string, string]> = [
      ["karaoke", "karaoke"],
      ["cumulative", "fade-words"],
      ["word-by-word", "word-current"],
      ["letter-by-letter", "typewriter"],
    ];
    let i = 0;
    for (const [style, expectedMode] of cases) {
      const pieceId = `pr${i++}`;
      await seedManifest(saveManifest, getLibiStorageDir, pieceId, 1920, 1080);
      await generateCaptions({ pieceId, fileId: "f1", style }, { readWords: async () => words });
      const overlays = (await loadManifest(pieceId)).overlays ?? [];
      expect(overlays.length).toBeGreaterThanOrEqual(1);
      for (const o of overlays) {
        expect((o as { reveal?: { mode: string } }).reveal?.mode).toBe(expectedMode);
        expect((o as { caption?: { styleRef?: string } }).caption?.styleRef).toBe(style);
      }
    }
  });

  it("clean/static style sets no reveal (plain subtitles)", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    await seedManifest(saveManifest, getLibiStorageDir, "pc", 1920, 1080);
    await generateCaptions({ pieceId: "pc", fileId: "f1", style: "clean" }, { readWords: async () => words });
    for (const o of (await loadManifest("pc")).overlays ?? []) {
      expect((o as { reveal?: unknown }).reveal).toBeUndefined();
    }
  });

  it("uses the point-text model: bottom anchor + bottom-safe position + canvas-scaled font + wrap width", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    const width = 854;
    const height = 480;
    await seedManifest(saveManifest, getLibiStorageDir, "pp", width, height);
    await generateCaptions({ pieceId: "pp", fileId: "f1" }, { readWords: async () => words });
    const o = ((await loadManifest("pp")).overlays ?? [])[0] as {
      anchor?: string;
      position?: { x: number; y: number };
      fontSize?: number;
      maxWidthPct?: number;
    };
    // Explicit anchor prevents legacy-normalize from forcing mid-center.
    expect(o.anchor).toBe("bottom-center");
    // Bottom-safe: anchor point sits in the lower ~6% margin band, horizontally centered.
    expect(o.position!.x).toBeCloseTo(width / 2, 1);
    expect(o.position!.y).toBeGreaterThan(height * 0.9);
    expect(o.position!.y).toBeLessThanOrEqual(height);
    // Font scaled to the (small) canvas, not the hardcoded 48px.
    expect(o.fontSize).toBeDefined();
    expect(o.fontSize!).toBeLessThan(48);
    expect(o.fontSize!).toBeGreaterThanOrEqual(20);
    // Explicit wrap width so wrapping is controlled (not Infinity → one giant line).
    expect(o.maxWidthPct).toBeGreaterThan(0);
    expect(o.maxWidthPct).toBeLessThanOrEqual(1);
  });

  it("re-running REPLACES the existing track (no duplicate overlays, stable group)", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    await seedManifest(saveManifest, getLibiStorageDir, "pd", 1920, 1080);
    const first = await generateCaptions({ pieceId: "pd", fileId: "f1", style: "cumulative" }, { readWords: async () => words });
    const countAfterFirst = ((await loadManifest("pd")).overlays ?? []).length;
    expect(countAfterFirst).toBe(first.data!.cueCount);
    // Restyle to karaoke — must REPLACE, not append.
    const second = await generateCaptions({ pieceId: "pd", fileId: "f1", style: "karaoke" }, { readWords: async () => words });
    const overlays = (await loadManifest("pd")).overlays ?? [];
    expect(overlays.length).toBe(second.data!.cueCount);
    expect(overlays.length).toBe(countAfterFirst);
    // No duplicate overlay ids (the source of the React duplicate-key errors).
    const ids = overlays.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    // All cues are now karaoke (the old cumulative track is gone).
    for (const o of overlays) {
      expect((o as { reveal?: { mode: string } }).reveal?.mode).toBe("karaoke");
    }
    // Group id is stable across restyles (per-file, not per-cue-count).
    expect(second.data!.captionGroupId).toBe(first.data!.captionGroupId);
  });

  it("stores real per-word timings (element-local) on each cue for voice-synced reveals", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    await seedManifest(saveManifest, getLibiStorageDir, "pw", 1920, 1080);
    await generateCaptions({ pieceId: "pw", fileId: "f1", style: "karaoke" }, { readWords: async () => words });
    const o = ((await loadManifest("pw")).overlays ?? [])[0] as {
      startTime: number;
      caption?: { words?: { text: string; start: number; end: number }[] };
    };
    const w = o.caption?.words;
    expect(w).toBeDefined();
    expect(w!.length).toBe(3); // Hello / there / world
    // Element-local: first word's local start == the lead offset (0.15), never negative,
    // and strictly ascending (real spacing preserved, not even-spacing).
    expect(w![0].start).toBeCloseTo(0.15, 2);
    expect(w![0].start).toBeGreaterThanOrEqual(0);
    expect(w![1].start).toBeGreaterThan(w![0].start);
    expect(w![2].start).toBeGreaterThan(w![1].start);
  });

  it("returns no_transcript when there are no spoken words", async () => {
    const { generateCaptions, saveManifest, getLibiStorageDir } = await setup();
    const pieceId = "p2";
    await seedManifest(saveManifest, getLibiStorageDir, pieceId, 1080, 1920);

    const result = await generateCaptions(
      { pieceId, fileId: "f2" },
      { readWords: async () => [] },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("no_transcript");
  });
});
