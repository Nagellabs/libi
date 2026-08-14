/**
 * Unified timeline clip operations (lib/composition/clip-ops): cut (split),
 * delete, and duplicate across scenes, overlays, and audio clips.
 *
 * HARD INVARIANT under test: delete removes the timeline entity only — it never
 * deletes the source FILE, and never disturbs OTHER entities that reference the
 * same fileId. The ops are pure manifest math (+ scene shards for resync), so no
 * test DB is needed (saveManifest's DB call is wrapped in try/catch).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitClip, deleteClip, duplicateClip } from "@/lib/composition/clip-ops";

let storageRoot: string;
const PIECE_ID = "p_clip_ops";

vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

const dir = () => join(storageRoot, "storage", PIECE_ID);
const writeScene = (id: string, scene: object) =>
  writeFileSync(join(dir(), `scene-${id}.json`), JSON.stringify(scene));
const readManifest = () =>
  JSON.parse(readFileSync(join(dir(), "composition.json"), "utf-8"));
type Clip = { id: string; startTime: number; duration: number; trimStart: number; kind: string; linkedSceneId?: string; linkedOverlayId?: string };
type Ov = { id: string; kind: string; startTime: number; duration: number; fileId?: string; trim?: { start: number; end: number }; z: number; group?: string };

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-clip-ops-"));
  process.env.LIBI_HOME = storageRoot;
  mkdirSync(dir(), { recursive: true });

  // One video scene (6s, fileId f1) + its inline audio.
  writeScene("s1", { id: "s1", type: "canvas", name: "S1", duration: 6, drawFunction: "// s1" });

  writeFileSync(
    join(dir(), "composition.json"),
    JSON.stringify({
      sceneOrder: ["s1"],
      width: 1920, height: 1080, fps: 30,
      scenes: [{ id: "s1", type: "canvas", name: "S1", duration: 6, drawFunction: "// s1" }],
      overlays: [
        { id: "vid-1", kind: "video", startTime: 0, duration: 4, fileId: "fv", trim: { start: 0, end: 4 }, rect: { x: 0, y: 0, width: 100, height: 100 }, z: 1, opacity: 1 },
        { id: "img-1", kind: "image", startTime: 0, duration: 3, fileId: "fimg", rect: { x: 0, y: 0, width: 100, height: 100 }, z: 2, opacity: 1, group: "stickers" },
        { id: "img-2", kind: "image", startTime: 0, duration: 3, fileId: "fimg", rect: { x: 0, y: 0, width: 100, height: 100 }, z: 3, opacity: 1 },
      ],
      audioClips: [
        { id: "c-s1", kind: "inline", linkedSceneId: "s1", fileId: "f1", startTime: 0, duration: 6, trimStart: 0, volume: 1, enabled: true },
        { id: "c-vid1", kind: "inline", linkedOverlayId: "vid-1", fileId: "fv", startTime: 0, duration: 4, trimStart: 0, volume: 1, enabled: true },
        { id: "c-music", kind: "standalone", fileId: "fmusic", startTime: 0, duration: 10, trimStart: 0, volume: 0.5, enabled: true },
      ],
    }),
  );
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  rmSync(storageRoot, { recursive: true, force: true });
});

describe("deleteClip — source file always survives", () => {
  it("deletes an image overlay but leaves a sibling overlay on the SAME fileId", async () => {
    const r = await deleteClip(PIECE_ID, "img-1");
    expect(r.ok).toBe(true);
    const m = readManifest();
    expect(m.overlays.find((o: Ov) => o.id === "img-1")).toBeUndefined();
    // img-2 references the same fileId fimg — it must be untouched.
    expect(m.overlays.find((o: Ov) => o.id === "img-2")).toBeDefined();
    expect(m.overlays.find((o: Ov) => o.id === "img-2").fileId).toBe("fimg");
  });

  it("deletes a video overlay and cascades only ITS coupled inline audio", async () => {
    const r = await deleteClip(PIECE_ID, "vid-1");
    expect(r.ok).toBe(true);
    const m = readManifest();
    expect(m.overlays.find((o: Ov) => o.id === "vid-1")).toBeUndefined();
    expect(m.audioClips.find((c: Clip) => c.id === "c-vid1")).toBeUndefined();
    // The scene's inline + the standalone music are untouched.
    expect(m.audioClips.find((c: Clip) => c.id === "c-s1")).toBeDefined();
    expect(m.audioClips.find((c: Clip) => c.id === "c-music")).toBeDefined();
  });

  it("deletes a standalone audio clip without touching scenes/overlays", async () => {
    const r = await deleteClip(PIECE_ID, "c-music");
    expect(r.ok).toBe(true);
    const m = readManifest();
    expect(m.audioClips.find((c: Clip) => c.id === "c-music")).toBeUndefined();
    expect(m.scenes).toHaveLength(1);
    expect(m.overlays).toHaveLength(3);
  });

  it("returns clip_not_found for an unknown id", async () => {
    const r = await deleteClip(PIECE_ID, "nope-123");
    expect(r).toEqual({ ok: false, error: "clip_not_found" });
  });
});

describe("deleteClip — ripple option", () => {
  // A dedicated sequential timeline (independent of the shared beforeEach
  // fixture, whose overlays all start at 0 and can't demonstrate a shift):
  // vidA[0-5) vidB[5-10) capC[12-14), plus vidB's coupled inline audio.
  beforeEach(() => {
    writeFileSync(
      join(dir(), "composition.json"),
      JSON.stringify({
        sceneOrder: [],
        width: 1920, height: 1080, fps: 30,
        scenes: [],
        overlays: [
          { id: "vidA", kind: "video", startTime: 0, duration: 5, fileId: "fa", trim: { start: 0, end: 5 }, rect: { x: 0, y: 0, width: 100, height: 100 }, z: 1, opacity: 1 },
          { id: "vidB", kind: "video", startTime: 5, duration: 5, fileId: "fb", trim: { start: 0, end: 5 }, rect: { x: 0, y: 0, width: 100, height: 100 }, z: 2, opacity: 1 },
          { id: "capC", kind: "text", startTime: 12, duration: 2, rect: { x: 0, y: 0, width: 100, height: 50 }, z: 3, opacity: 1, content: "hi", font: "sans-serif", color: "#fff", align: "center" },
        ],
        audioClips: [
          { id: "c-vidB", kind: "inline", linkedOverlayId: "vidB", fileId: "fb", startTime: 5, duration: 5, trimStart: 0, volume: 1, enabled: true },
        ],
      }),
    );
  });

  it("default (ripple omitted) leaves the gap — unchanged behavior", async () => {
    const r = await deleteClip(PIECE_ID, "vidB");
    expect(r.ok).toBe(true);
    const m = readManifest();
    expect(m.overlays.find((o: Ov) => o.id === "vidB")).toBeUndefined();
    // capC stays put — the hole [5,10) is left behind.
    expect(m.overlays.find((o: Ov) => o.id === "capC").startTime).toBe(12);
  });

  it("ripple:true closes the gap, leaving earlier clips untouched", async () => {
    const r = await deleteClip(PIECE_ID, "vidB", { ripple: true });
    expect(r.ok).toBe(true);
    const m = readManifest();
    expect(m.overlays.find((o: Ov) => o.id === "vidB")).toBeUndefined();
    expect(m.overlays.find((o: Ov) => o.id === "vidA").startTime).toBe(0);
    expect(m.overlays.find((o: Ov) => o.id === "capC").startTime).toBe(7); // 12 - 5
  });
});

describe("deleteClip — ripple option (scene family: no double-shift)", () => {
  // Reviewer's exact repro (C1): a 4-scene sequential timeline —
  //   S0[0-5) dur 5, S1[5-10) dur 5 (deleted), S2[10-16) dur 6, S3[16-21) dur 5
  // — with inline audio "c-s3" linked to S3, starting at 16.
  //
  // Scenes already ripple natively: removing S1 from sceneOrder + the
  // resyncLinkedClips walk inside removeSceneAndUpdateManifest re-derives
  // c-s3's startTime from the NEW order (S0,S2,S3) to the correct 11
  // (5 + 6). Layering rippleCloseGap on top of that (the pre-fix bug) shifts
  // c-s3 a SECOND time to 6 — wrong.
  beforeEach(() => {
    const scenes = [
      { id: "S0", type: "canvas", name: "S0", duration: 5, drawFunction: "// S0" },
      { id: "S1", type: "canvas", name: "S1", duration: 5, drawFunction: "// S1" },
      { id: "S2", type: "canvas", name: "S2", duration: 6, drawFunction: "// S2" },
      { id: "S3", type: "canvas", name: "S3", duration: 5, drawFunction: "// S3" },
    ];
    for (const s of scenes) writeScene(s.id, s);
    writeFileSync(
      join(dir(), "composition.json"),
      JSON.stringify({
        sceneOrder: ["S0", "S1", "S2", "S3"],
        width: 1920, height: 1080, fps: 30,
        scenes,
        overlays: [],
        audioClips: [
          { id: "c-s3", kind: "inline", linkedSceneId: "S3", fileId: "f3", startTime: 16, duration: 5, trimStart: 0, volume: 1, enabled: true },
        ],
      }),
    );
  });

  it("does not double-shift a scene-linked inline audio clip two hops downstream", async () => {
    const r = await deleteClip(PIECE_ID, "S1", { ripple: true });
    expect(r.ok).toBe(true);
    const m = readManifest();
    expect(m.sceneOrder).toEqual(["S0", "S2", "S3"]);
    // Correct: S2 now starts at 5 (right after S0), S3 at 5+6=11.
    expect(m.audioClips.find((c: Clip) => c.id === "c-s3").startTime).toBe(11);
  });
});

describe("splitClip — cut at a time", () => {
  it("splits a canvas scene + resyncs both inline audio halves", async () => {
    const r = await splitClip(PIECE_ID, "s1", 2.5);
    expect(r.ok).toBe(true);
    const m = readManifest();
    expect(m.sceneOrder).toHaveLength(2);
    const [head, tail] = m.scenes;
    expect(head.id).toBe("s1");
    expect(head.duration).toBeCloseTo(2.5);
    expect(tail.duration).toBeCloseTo(3.5);
    // Canvas scenes carry no source trim window — a split is a pure duration cut.
    expect(head.trim).toBeUndefined();
    expect(tail.trim).toBeUndefined();
    // Inline audio: head resynced to [0,2.5]; a NEW tail clip for the tail scene.
    const headClip = m.audioClips.find((c: Clip) => c.id === "c-s1");
    expect(headClip.startTime).toBeCloseTo(0);
    expect(headClip.duration).toBeCloseTo(2.5);
    const tailClip = m.audioClips.find((c: Clip) => c.linkedSceneId === tail.id && c.id !== "c-s1");
    expect(tailClip).toBeDefined();
    expect(tailClip.startTime).toBeCloseTo(2.5);
    expect(tailClip.duration).toBeCloseTo(3.5);
    // A canvas scene has no source trim window, so both halves play their
    // linked file from the top.
    expect(tailClip.trimStart).toBeCloseTo(0);
  });

  it("splits a video overlay + its coupled inline audio", async () => {
    const r = await splitClip(PIECE_ID, "vid-1", 1.5);
    expect(r.ok).toBe(true);
    const m = readManifest();
    const vids = m.overlays.filter((o: Ov) => o.kind === "video");
    expect(vids).toHaveLength(2);
    const head = m.overlays.find((o: Ov) => o.id === "vid-1");
    expect(head.duration).toBeCloseTo(1.5);
    expect(head.trim).toEqual({ start: 0, end: 1.5 });
    const tail = vids.find((o: Ov) => o.id !== "vid-1");
    expect(tail.startTime).toBeCloseTo(1.5);
    expect(tail.trim).toEqual({ start: 1.5, end: 4 });
    // The tail goes on a new track directly below the head (distinct, lower z).
    expect(tail.z).toBeLessThan(1);
    // Coupled inline audio split too.
    const tailClip = m.audioClips.find((c: Clip) => c.linkedOverlayId === tail.id);
    expect(tailClip.startTime).toBeCloseTo(1.5);
    expect(tailClip.trimStart).toBeCloseTo(1.5);
  });

  it("splits an image overlay into two adjacent halves", async () => {
    const r = await splitClip(PIECE_ID, "img-1", 1);
    expect(r.ok).toBe(true);
    const m = readManifest();
    const imgs = m.overlays.filter((o: Ov) => o.fileId === "fimg");
    // img-1 (split → 2) + img-2 (untouched) = 3.
    expect(imgs).toHaveLength(3);
    const head = m.overlays.find((o: Ov) => o.id === "img-1");
    expect(head.duration).toBeCloseTo(1);
  });

  it("rejects a split outside the clip window", async () => {
    expect(await splitClip(PIECE_ID, "c-music", 0)).toEqual({ ok: false, error: "split_out_of_bounds" });
    expect(await splitClip(PIECE_ID, "c-music", 99)).toEqual({ ok: false, error: "split_out_of_bounds" });
  });

  it("rejects a split that would leave a sub-frame sliver", async () => {
    // c-music spans [0,10]; cutting 0.01s in leaves a <1/30s head.
    expect(await splitClip(PIECE_ID, "c-music", 0.01)).toEqual({ ok: false, error: "split_out_of_bounds" });
  });
});

describe("duplicateClip — copy adjacent", () => {
  it("duplicates a scene right after it with its own inline audio", async () => {
    const r = await duplicateClip(PIECE_ID, "s1");
    expect(r.ok).toBe(true);
    const m = readManifest();
    expect(m.sceneOrder).toHaveLength(2);
    const copyId = m.sceneOrder[1];
    expect(copyId).not.toBe("s1");
    const copy = m.scenes.find((s: { id: string; drawFunction: string; duration: number }) => s.id === copyId);
    expect(copy.drawFunction).toBe("// s1");
    expect(copy.duration).toBe(6);
    // Copy gets its own inline clip, resynced to start at 6 (right after s1).
    const copyClip = m.audioClips.find((c: Clip) => c.linkedSceneId === copyId);
    expect(copyClip).toBeDefined();
    expect(copyClip.startTime).toBeCloseTo(6);
  });

  it("duplicates an image overlay adjacent on the same lane", async () => {
    const r = await duplicateClip(PIECE_ID, "img-1");
    expect(r.ok).toBe(true);
    const m = readManifest();
    const imgs = m.overlays.filter((o: Ov) => o.fileId === "fimg");
    expect(imgs).toHaveLength(3); // img-1 + copy + img-2
    if (!r.ok) throw new Error("unreachable");
    const copy = m.overlays.find((o: Ov) => o.id === r.newId);
    expect(copy.startTime).toBeCloseTo(3); // img-1.startTime(0) + duration(3)
    // New row DIRECTLY BELOW the source: distinct z between img-1 (2) and the
    // next-lower overlay vid-1 (1) — never a tie with the source.
    expect(copy.z).toBeLessThan(2);
    expect(copy.z).toBeGreaterThan(1);
    expect(copy.group).toBe("stickers");
  });

  it("stacks repeated duplicates consistently downward (no z-tie)", async () => {
    const a = await duplicateClip(PIECE_ID, "img-1");
    const b = await duplicateClip(PIECE_ID, "img-1");
    if (!a.ok || !b.ok) throw new Error("unreachable");
    const m = readManifest();
    const src = m.overlays.find((o: Ov) => o.id === "img-1");
    const copyA = m.overlays.find((o: Ov) => o.id === a.newId);
    const copyB = m.overlays.find((o: Ov) => o.id === b.newId);
    // Both copies sit below the source, each on its own distinct z (all 3 unique).
    const zs = [src.z, copyA.z, copyB.z];
    expect(new Set(zs).size).toBe(3);
    expect(copyA.z).toBeLessThan(src.z);
    expect(copyB.z).toBeLessThan(src.z);
  });

  it("duplicates an audio clip as a FREE standalone copy", async () => {
    const r = await duplicateClip(PIECE_ID, "c-s1"); // c-s1 is inline (linked to s1)
    expect(r.ok).toBe(true);
    const m = readManifest();
    if (!r.ok) throw new Error("unreachable");
    const copy = m.audioClips.find((c: Clip) => c.id === r.newId);
    expect(copy.kind).toBe("standalone");
    expect(copy.linkedSceneId).toBeUndefined();
    expect(copy.linkedOverlayId).toBeUndefined();
    expect(copy.startTime).toBeCloseTo(6); // c-s1.startTime(0) + duration(6)
  });
});
