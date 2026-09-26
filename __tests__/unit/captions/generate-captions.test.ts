import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTempStorageDir, cleanupTempDir } from "../../helpers/test-storage";
import type { SttWord } from "@/lib/analysis/types";

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
    overlays: Parameters<typeof saveManifest>[1]["overlays"] = [],
    audioClips: Parameters<typeof saveManifest>[1]["audioClips"] = undefined,
  ) {
    fs.mkdirSync(path.join(getLibiStorageDir(), pieceId), { recursive: true });
    await saveManifest(pieceId, {
      width,
      height,
      fps: 30,
      overlays,
      ...(audioClips ? { audioClips } : {}),
    });
  }

  const words: SttWord[] = [
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
    // Element-local: the fixture's first word starts at t=0, inside the lead
    // window (0.15s), so the cue's own start is floored at 0 (never negative
    // — see cues.ts) and the first word's local offset collapses to 0 rather
    // than the full lead. Later words keep their real (ascending) spacing.
    expect(w![0].start).toBeCloseTo(0, 2);
    expect(w![0].start).toBeGreaterThanOrEqual(0);
    expect(w![1].start).toBeGreaterThan(w![0].start);
    expect(w![2].start).toBeGreaterThan(w![1].start);
  });

  it("preserves the real lead offset when there's room before the first word", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    await seedManifest(saveManifest, getLibiStorageDir, "plead", 1920, 1080);
    const lateWords: SttWord[] = [
      { text: "Hello", start: 5.0, end: 5.4, type: "word" },
      { text: "there", start: 5.5, end: 5.9, type: "word" },
    ];
    await generateCaptions({ pieceId: "plead", fileId: "f1", style: "karaoke" }, { readWords: async () => lateWords });
    const o = ((await loadManifest("plead")).overlays ?? [])[0] as { startTime: number };
    // Plenty of room before t=5.0, so the default 0.15s lead is not clipped.
    expect(o.startTime).toBeCloseTo(4.85, 2);
  });

  it("clamps the last caption overlay to end at (or before) the transcribed video overlay's end", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    const videoOverlay = {
      id: "vid-1",
      kind: "video" as const,
      fileId: "f1",
      startTime: 0,
      duration: 5,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      z: 0,
      opacity: 1,
    };
    await seedManifest(saveManifest, getLibiStorageDir, "pv", 1920, 1080, [videoOverlay]);
    // Last word ends at 4.8s; the default 0.4s hold would push the cue's end
    // to 5.2s — past the 5s video. It must be clamped to the video's own end.
    const clipWords: SttWord[] = [
      { text: "Hello", start: 0.0, end: 0.4, type: "word" },
      { text: "world", start: 4.4, end: 4.8, type: "word" },
    ];
    const result = await generateCaptions({ pieceId: "pv", fileId: "f1" }, { readWords: async () => clipWords });
    expect(result.success).toBe(true);
    const overlays = ((await loadManifest("pv")).overlays ?? []).filter(
      (o) => (o as { kind: string }).kind === "text",
    ) as { startTime: number; duration: number }[];
    expect(overlays.length).toBeGreaterThanOrEqual(1);
    const last = overlays.reduce((a, b) => (a.startTime + a.duration > b.startTime + b.duration ? a : b));
    expect(last.startTime + last.duration).toBeLessThanOrEqual(5 + 1e-6);
  });

  it("a plain split (libi.split_clip): BOTH halves get captioned, continuous across the split point", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    // Exactly the shape splitOverlay() produces (lib/composition/clip-ops.ts):
    // head keeps startTime 0, tail starts where the cut was made (3), and
    // trims are adjacent with NO gap (head [0,3), tail [3,6)).
    const clipA = {
      id: "vid-a", kind: "video" as const, fileId: "f1",
      startTime: 0, duration: 3, trim: { start: 0, end: 3 },
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    const clipB = {
      id: "vid-b", kind: "video" as const, fileId: "f1",
      startTime: 3, duration: 3, trim: { start: 3, end: 6 },
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    await seedManifest(saveManifest, getLibiStorageDir, "psplit", 1920, 1080, [clipA, clipB]);
    // Two words before the cut (clipA's window), two after (clipB's window).
    const words: SttWord[] = [
      { text: "One", start: 0.5, end: 0.9, type: "word" },
      { text: "Two", start: 2.5, end: 2.9, type: "word" },
      { text: "Three", start: 3.5, end: 3.9, type: "word" },
      { text: "Four", start: 5.2, end: 5.6, type: "word" },
    ];
    const result = await generateCaptions({ pieceId: "psplit", fileId: "f1" }, { readWords: async () => words });
    expect(result.success).toBe(true);
    const overlays = ((await loadManifest("psplit")).overlays ?? []).filter(
      (o) => (o as { kind: string }).kind === "text",
    ) as { startTime: number; duration: number; content?: string }[];
    // BOTH halves produced a caption — this is the regression the fix
    // targets: an earlier version picked only ONE overlay and silently
    // dropped every word outside it, which for a plain split meant the
    // second half of the clip never got captioned at all.
    expect(overlays.length).toBe(2);
    const sorted = [...overlays].sort((a, b) => a.startTime - b.startTime);
    expect(sorted[0].content).toBe("One Two");
    expect(sorted[1].content).toBe("Three Four");
    // Each half stays within its OWN window — never bleeds before its own
    // clip begins or past the far side of the split.
    expect(sorted[0].startTime).toBeGreaterThanOrEqual(0);
    expect(sorted[0].startTime + sorted[0].duration).toBeLessThanOrEqual(3 + 1e-6);
    expect(sorted[1].startTime).toBeGreaterThanOrEqual(3);
    expect(sorted[1].startTime + sorted[1].duration).toBeLessThanOrEqual(6 + 1e-6);
    // Continuous across the split point: the second half starts at (or very
    // close to) where the first half's window ends — no multi-second gap
    // swallowing the boundary, and no overlap.
    expect(sorted[1].startTime).toBeLessThan(sorted[0].startTime + sorted[0].duration + 1);
    expect(sorted[1].startTime).toBeGreaterThanOrEqual(sorted[0].startTime + sorted[0].duration - 1e-6);
  });

  it("a split with the MIDDLE cut out: words spoken during the cut are dropped, both remaining halves keep theirs", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    // clipA plays source [0,2) at timeline [0,2); clipB plays source [5,7) at
    // timeline [2,4) — source [2,5) was cut out of the middle entirely.
    const clipA = {
      id: "vid-a", kind: "video" as const, fileId: "f1",
      startTime: 0, duration: 2, trim: { start: 0, end: 2 },
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    const clipB = {
      id: "vid-b", kind: "video" as const, fileId: "f1",
      startTime: 2, duration: 2, trim: { start: 5, end: 7 },
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    await seedManifest(saveManifest, getLibiStorageDir, "pcut", 1920, 1080, [clipA, clipB]);
    const words: SttWord[] = [
      { text: "One", start: 0.5, end: 0.9, type: "word" },
      // Spoken during the cut-out middle [2,5) — neither clip ever plays this.
      { text: "Cut", start: 3.0, end: 3.4, type: "word" },
      { text: "Two", start: 5.5, end: 5.9, type: "word" },
    ];
    const result = await generateCaptions({ pieceId: "pcut", fileId: "f1" }, { readWords: async () => words });
    expect(result.success).toBe(true);
    const overlays = ((await loadManifest("pcut")).overlays ?? []).filter(
      (o) => (o as { kind: string }).kind === "text",
    ) as { startTime: number; duration: number; content?: string }[];
    expect(overlays.length).toBe(2);
    const contents = overlays.map((o) => o.content);
    expect(contents).toContain("One");
    expect(contents).toContain("Two");
    // "Cut" never appears anywhere — it was spoken during material neither
    // overlay plays.
    expect(contents.some((c) => c?.includes("Cut"))).toBe(false);
  });

  it("each video overlay's window is captioned independently — no 'widest window' choice needed", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    // clipA's window never receives a matching word; clipB's does. Previously
    // an ambiguous first word forced picking ONE overlay (by "widest visible
    // window") and processing only its words — now every overlay simply
    // processes its OWN words independently, so there's no ambiguity to
    // resolve in the first place.
    const clipA = {
      id: "vid-a", kind: "video" as const, fileId: "f1",
      startTime: 0, duration: 2, trim: { start: 0, end: 2 },
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    const clipB = {
      id: "vid-b", kind: "video" as const, fileId: "f1",
      startTime: 2, duration: 4, trim: { start: 10, end: 14 },
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    await seedManifest(saveManifest, getLibiStorageDir, "pindep", 1920, 1080, [clipA, clipB]);
    // "Stray" is inside NEITHER window — dropped, decides nothing.
    const words: SttWord[] = [
      { text: "Stray", start: 5.0, end: 5.4, type: "word" },
      { text: "Hello", start: 11.0, end: 11.4, type: "word" },
      { text: "world", start: 13.5, end: 13.9, type: "word" },
    ];
    const result = await generateCaptions({ pieceId: "pindep", fileId: "f1" }, { readWords: async () => words });
    expect(result.success).toBe(true);
    const overlays = ((await loadManifest("pindep")).overlays ?? []).filter(
      (o) => (o as { kind: string }).kind === "text",
    ) as { startTime: number; duration: number; content?: string }[];
    // Only clipB produced a cue — clipA's window had no matching words, which
    // is not an error, just an empty window.
    expect(overlays.length).toBe(1);
    expect(overlays[0].content).toBe("Hello world");
    expect(overlays[0].startTime).toBeGreaterThanOrEqual(2);
    expect(overlays[0].startTime + overlays[0].duration).toBeCloseTo(6, 5);
  });

  it("two overlapping-timeline windows never collide on overlay id", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    // Pathological but possible: two video overlays for the same fileId at
    // the SAME timeline startTime (e.g. one above the other). Each window's
    // word, after its own shift, lands at the same rounded timeline start —
    // without the window index in the id these would collide.
    const clipA = {
      id: "vid-a", kind: "video" as const, fileId: "f1",
      startTime: 0, duration: 2, trim: { start: 0, end: 2 },
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    const clipB = {
      id: "vid-b", kind: "video" as const, fileId: "f1",
      startTime: 0, duration: 2, trim: { start: 10, end: 12 },
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 1, opacity: 1,
    };
    await seedManifest(saveManifest, getLibiStorageDir, "pcollide", 1920, 1080, [clipA, clipB]);
    const words: SttWord[] = [
      { text: "Uno", start: 0.5, end: 0.9, type: "word" }, // clipA window
      { text: "Diez", start: 10.5, end: 10.9, type: "word" }, // clipB window, shifts to the same 0.5
    ];
    const result = await generateCaptions({ pieceId: "pcollide", fileId: "f1" }, { readWords: async () => words });
    expect(result.success).toBe(true);
    const overlays = ((await loadManifest("pcollide")).overlays ?? []).filter(
      (o) => (o as { kind: string }).kind === "text",
    ) as { id: string; content?: string }[];
    expect(overlays.length).toBe(2);
    expect(new Set(overlays.map((o) => o.id)).size).toBe(2);
    expect(overlays.map((o) => o.content).sort()).toEqual(["Diez", "Uno"]);
  });

  it("no word falls in any window, no previous track: succeeds with cueCount 0, removedCueCount 0, and a readable hint", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    const clipA = {
      id: "vid-a", kind: "video" as const, fileId: "f1",
      startTime: 0, duration: 2, trim: { start: 0, end: 2 },
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    await seedManifest(saveManifest, getLibiStorageDir, "pnone", 1920, 1080, [clipA]);
    // Entirely outside clipA's visible window [0,2).
    const words: SttWord[] = [{ text: "Later", start: 10.0, end: 10.4, type: "word" }];
    const result = await generateCaptions({ pieceId: "pnone", fileId: "f1" }, { readWords: async () => words });
    expect(result.success).toBe(true);
    expect(result.data!.cueCount).toBe(0);
    expect(result.data!.removedCueCount).toBe(0);
    // Readable sentence, not a bare enum token — an agent reads this and
    // relays it, it does not pattern-match it.
    expect(result.data!.hint).toMatch(/no speech falls inside the playing part of any video overlay or audio clip/i);
    expect(result.data!.hint).not.toBe("no_speech_in_visible_range");
    const overlays = ((await loadManifest("pnone")).overlays ?? []).filter(
      (o) => (o as { kind: string }).kind === "text",
    );
    expect(overlays.length).toBe(0);
  });

  it("no word falls in any window, an existing caption track: it is removed, and the hint says so with its cue count", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    const clipA = {
      id: "vid-a", kind: "video" as const, fileId: "f1",
      startTime: 0, duration: 2, trim: { start: 0, end: 2 },
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    await seedManifest(saveManifest, getLibiStorageDir, "pgone", 1920, 1080, [clipA]);
    // First run: speech IS inside the window, builds a real caption track.
    const first = await generateCaptions({ pieceId: "pgone", fileId: "f1" }, { readWords: async () => words });
    expect(first.success).toBe(true);
    const removedCueCount = first.data!.cueCount as number;
    expect(removedCueCount).toBeGreaterThanOrEqual(1);

    // Second run against the SAME fileId: now entirely outside the window.
    const laterWords: SttWord[] = [{ text: "Later", start: 10.0, end: 10.4, type: "word" }];
    const second = await generateCaptions({ pieceId: "pgone", fileId: "f1" }, { readWords: async () => laterWords });
    expect(second.success).toBe(true);
    expect(second.data!.cueCount).toBe(0);
    expect(second.data!.removedCueCount).toBe(removedCueCount);
    expect(second.data!.hint).toMatch(/no speech falls inside the playing part of any video overlay or audio clip/i);
    expect(second.data!.hint).toMatch(new RegExp(`previous caption track \\(${removedCueCount} cues?\\) was removed`, "i"));

    const overlays = ((await loadManifest("pgone")).overlays ?? []).filter(
      (o) => (o as { kind: string }).kind === "text",
    );
    expect(overlays.length).toBe(0);
  });

  it("a video overlay placed at startTime 2 (no trim) shifts every caption 2s later, never to source time", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    const videoOverlay = {
      id: "vid-1", kind: "video" as const, fileId: "f1",
      startTime: 2, duration: 5,
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    await seedManifest(saveManifest, getLibiStorageDir, "pstart2", 1920, 1080, [videoOverlay]);
    const words: SttWord[] = [
      { text: "Hello", start: 0.0, end: 0.4, type: "word" },
      { text: "world", start: 4.6, end: 5.0, type: "word" },
    ];
    const result = await generateCaptions({ pieceId: "pstart2", fileId: "f1" }, { readWords: async () => words });
    expect(result.success).toBe(true);
    const overlays = ((await loadManifest("pstart2")).overlays ?? []).filter(
      (o) => (o as { kind: string }).kind === "text",
    ) as { startTime: number; duration: number }[];
    expect(overlays.length).toBe(1);
    // Without the shift this cue would start at ~0 (2s too early, and
    // overlapping whatever plays before the video begins). The lead-in floor
    // is the overlay's own startTime (2), not 0, so it lands exactly there.
    expect(overlays[0].startTime).toBeCloseTo(2, 5);
    // maxEnd is the video's TIMELINE end (startTime 2 + duration 5 = 7), not
    // its source-relative duration (5).
    expect(overlays[0].startTime + overlays[0].duration).toBeCloseTo(7, 5);
  });

  it("a video overlay trimmed to start at source 3s shifts kept words and drops pre-trim audio", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    const videoOverlay = {
      id: "vid-1", kind: "video" as const, fileId: "f1",
      startTime: 0, duration: 4, trim: { start: 3, end: 10 },
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    await seedManifest(saveManifest, getLibiStorageDir, "ptrim3", 1920, 1080, [videoOverlay]);
    const words: SttWord[] = [
      // Spoken BEFORE the trim point — this clip never plays source 0..3s,
      // so this word must not produce a (wrongly-timed) caption at all.
      { text: "before", start: 1.0, end: 1.4, type: "word" },
      // Spoken just after the trim point — inside the visible window.
      { text: "Hello", start: 3.2, end: 3.6, type: "word" },
    ];
    const result = await generateCaptions({ pieceId: "ptrim3", fileId: "f1" }, { readWords: async () => words });
    expect(result.success).toBe(true);
    const overlays = ((await loadManifest("ptrim3")).overlays ?? []).filter(
      (o) => (o as { kind: string }).kind === "text",
    ) as { startTime: number; duration: number; content?: string }[];
    expect(overlays.length).toBe(1);
    // "before" is excluded — it was spoken during the trimmed-out lead-in the
    // clip never shows.
    expect(overlays[0].content).toBe("Hello");
    // Shifted by (startTime - trim.start) = 0 - 3 = -3: source 3.2 → timeline 0.2.
    expect(overlays[0].startTime).toBeCloseTo(0.05, 2); // lead-adjusted (0.2 - 0.15)
  });

  // ── Audio-clip placement (the narration case) ─────────────────────────────
  // A voiceover is an AUDIO CLIP, not a video overlay. Its words are
  // source-relative just the same, so they must go through the clip's own
  // placement: timeline = source - trimStart + startTime, visible source
  // window [trimStart, trimStart + duration).
  const audioClip = (over: Partial<{ id: string; fileId: string; startTime: number; duration: number; trimStart: number; kind: "inline" | "standalone"; linkedOverlayId: string }> = {}) => ({
    id: "aud-1", kind: "standalone" as const, fileId: "f1",
    startTime: 0, duration: 10, trimStart: 0, volume: 1, enabled: true,
    ...over,
  });
  const textCues = async (loadManifest: typeof import("@/lib/composition/persistence").loadManifest, pieceId: string) =>
    (((await loadManifest(pieceId)).overlays ?? []).filter(
      (o) => (o as { kind: string }).kind === "text",
    ) as { startTime: number; duration: number; content?: string }[]).sort((a, b) => a.startTime - b.startTime);

  it("a narration AUDIO clip placed at startTime 2 shifts every caption 2s later", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    await seedManifest(saveManifest, getLibiStorageDir, "pa2", 1920, 1080, [], [audioClip({ startTime: 2, duration: 5 })]);
    const w: SttWord[] = [
      { text: "Hello", start: 0.0, end: 0.4, type: "word" },
      { text: "world", start: 4.0, end: 4.4, type: "word" },
    ];
    const result = await generateCaptions({ pieceId: "pa2", fileId: "f1" }, { readWords: async () => w });
    expect(result.success).toBe(true);
    const cues = await textCues(loadManifest, "pa2");
    expect(cues.length).toBeGreaterThanOrEqual(1);
    // Floored at the clip's own start (2), never at source time 0.
    expect(cues[0].startTime).toBeCloseTo(2, 5);
    const last = cues[cues.length - 1];
    // "world" spoken at source 4.0 → timeline 6.0; the cue ends inside the clip (≤ 7).
    expect(last.startTime + last.duration).toBeGreaterThan(6);
    expect(last.startTime + last.duration).toBeLessThanOrEqual(7 + 1e-6);
  });

  it("the observed case: narration at startTime 0.15 captions 150 ms later, not at 0", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    await seedManifest(saveManifest, getLibiStorageDir, "pa015", 1920, 1080, [], [audioClip({ startTime: 0.15, duration: 5 })]);
    const w: SttWord[] = [
      { text: "Hello", start: 1.0, end: 1.4, type: "word" },
    ];
    await generateCaptions({ pieceId: "pa015", fileId: "f1" }, { readWords: async () => w });
    const cues = await textCues(loadManifest, "pa015");
    // source 1.0 → timeline 1.15, minus the default 0.15 lead-in.
    expect(cues[0].startTime).toBeCloseTo(1.0, 3);
  });

  it("an audio clip trimmed in (trimStart 3) drops pre-trim words and shifts the rest", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    await seedManifest(saveManifest, getLibiStorageDir, "pain", 1920, 1080, [], [audioClip({ startTime: 1, duration: 5, trimStart: 3 })]);
    const w: SttWord[] = [
      { text: "before", start: 1.0, end: 1.4, type: "word" },
      { text: "Hello", start: 4.0, end: 4.4, type: "word" },
    ];
    await generateCaptions({ pieceId: "pain", fileId: "f1" }, { readWords: async () => w });
    const cues = await textCues(loadManifest, "pain");
    expect(cues.map((c) => c.content)).toEqual(["Hello"]);
    // source 4.0 - trimStart 3 + startTime 1 = timeline 2.0, minus 0.15 lead.
    expect(cues[0].startTime).toBeCloseTo(1.85, 3);
  });

  it("an audio clip trimmed out (duration shorter than the source) drops words after the trim-out", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    await seedManifest(saveManifest, getLibiStorageDir, "paout", 1920, 1080, [], [audioClip({ startTime: 0, duration: 3, trimStart: 0 })]);
    const w: SttWord[] = [
      { text: "kept", start: 1.0, end: 1.4, type: "word" },
      { text: "cut", start: 5.0, end: 5.4, type: "word" },
    ];
    await generateCaptions({ pieceId: "paout", fileId: "f1" }, { readWords: async () => w });
    const cues = await textCues(loadManifest, "paout");
    expect(cues.map((c) => c.content)).toEqual(["kept"]);
    const last = cues[cues.length - 1];
    expect(last.startTime + last.duration).toBeLessThanOrEqual(3 + 1e-6);
  });

  it("a video overlay's COUPLED inline audio clip does not caption the same words twice", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    const video = {
      id: "vid-1", kind: "video" as const, fileId: "f1",
      startTime: 2, duration: 5,
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    // Coupled clip whose persisted timing drifted — the VIDEO's placement wins.
    await seedManifest(saveManifest, getLibiStorageDir, "pcpl", 1920, 1080, [video], [
      audioClip({ kind: "inline", linkedOverlayId: "vid-1", startTime: 0, duration: 5 }),
    ]);
    await generateCaptions({ pieceId: "pcpl", fileId: "f1" }, { readWords: async () => words });
    const cues = await textCues(loadManifest, "pcpl");
    expect(cues.map((c) => c.content).join(" ")).toBe("Hello there world");
    expect(cues[0].startTime).toBeCloseTo(2, 5);
  });

  it("a DETACHED audio clip moved away from its video: captions follow the audio, once", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    const video = {
      id: "vid-1", kind: "video" as const, fileId: "f1",
      startTime: 0, duration: 5,
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    await seedManifest(saveManifest, getLibiStorageDir, "pdet", 1920, 1080, [video], [
      audioClip({ kind: "standalone", linkedOverlayId: "vid-1", startTime: 4, duration: 5 }),
    ]);
    await generateCaptions({ pieceId: "pdet", fileId: "f1" }, { readWords: async () => words });
    const cues = await textCues(loadManifest, "pdet");
    expect(cues.map((c) => c.content).join(" ")).toBe("Hello there world");
    expect(cues[0].startTime).toBeCloseTo(4, 5);
  });

  // A free (unlinked) audio clip of a video's OWN file, lined up with that
  // video, plays the same words at the same timeline time — e.g. the audio
  // re-added with audio_add_clip kind "standalone" after the inline strip was
  // deleted. Two windows with the same mapping must caption each word once.
  it("an unlinked audio clip lined up with its video's own file does not double the captions", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    const video = {
      id: "vid-1", kind: "video" as const, fileId: "f1",
      startTime: 1, duration: 5,
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    await seedManifest(saveManifest, getLibiStorageDir, "pfree", 1920, 1080, [video], [
      audioClip({ id: "aud-free", startTime: 1, duration: 5, trimStart: 0 }),
    ]);
    await generateCaptions({ pieceId: "pfree", fileId: "f1" }, { readWords: async () => words });
    const cues = await textCues(loadManifest, "pfree");
    expect(cues.map((c) => c.content).join(" ")).toBe("Hello there world");
    expect(cues[0].startTime).toBeCloseTo(1, 5);
  });

  it("overlapping windows with the SAME mapping merge into their union (words once, clamp at the far end)", async () => {
    const { generateCaptions, loadManifest, saveManifest, getLibiStorageDir } = await setup();
    // Video plays source [0,3) at timeline [0,3); the clip plays source [2,6)
    // at timeline [2,6) — same shift (0), overlapping on [2,3).
    const video = {
      id: "vid-1", kind: "video" as const, fileId: "f1",
      startTime: 0, duration: 3,
      rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, opacity: 1,
    };
    await seedManifest(saveManifest, getLibiStorageDir, "punion", 1920, 1080, [video], [
      audioClip({ startTime: 2, duration: 4, trimStart: 2 }),
    ]);
    const w: SttWord[] = [
      { text: "one", start: 0.5, end: 0.9, type: "word" },
      { text: "two", start: 2.4, end: 2.8, type: "word" }, // inside BOTH windows
      { text: "three", start: 5.0, end: 5.4, type: "word" },
    ];
    await generateCaptions({ pieceId: "punion", fileId: "f1" }, { readWords: async () => w });
    const cues = await textCues(loadManifest, "punion");
    const all = cues.map((c) => c.content).join(" ").split(/\s+/);
    expect(all.filter((x) => x === "two")).toHaveLength(1);
    expect(all).toEqual(["one", "two", "three"]);
    const last = cues[cues.length - 1];
    expect(last.startTime + last.duration).toBeLessThanOrEqual(6 + 1e-6);
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
