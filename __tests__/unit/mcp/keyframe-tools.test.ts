/**
 * Phase 4 — overlay keyframe MCP tools (add/delete/set-easing/list/animate).
 *
 * These handlers operate purely on the composition manifest via storage (no DB),
 * so the setup mirrors overlay-update-transform.test.ts: mock @/lib/storage with
 * a temp dir, seed an overlay via addOverlay (or addOverlayToManifest for the
 * tracked kind, which addOverlay can't create), then exercise the handlers.
 *
 * Time convention under test: callers pass SECONDS; the store is NORMALIZED
 * (t = seconds / duration). list_keyframes converts back to seconds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import {
  addOverlay,
  addKeyframe,
  deleteKeyframe,
  setKeyframeEasing,
  listKeyframes,
} from "@/mcp/tools/overlay-tools";
import { addOverlayToManifest, loadManifest } from "@/lib/composition/persistence";
import type { PersistedOverlay } from "@/lib/composition/persistence";

const baseRect = { x: 10, y: 20, width: 100, height: 50 };

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

const pieceId = "piece-keyframes-test";

/** Seed a text overlay (duration 4s) and return its id. */
async function seedTextOverlay(duration = 4): Promise<string> {
  const add = await addOverlay({
    pieceId,
    kind: "text",
    startTime: 0,
    duration,
    rect: baseRect,
    z: 1,
    opacity: 1,
    content: "hello",
    font: "32px Inter",
    color: "#ffffff",
    align: "center",
  } as never);
  expect(add.success).toBe(true);
  return (add.data as { overlayId: string }).overlayId;
}

/** Read an overlay back from the manifest. */
async function readOverlay(overlayId: string) {
  const manifest = await loadManifest(pieceId);
  return manifest.overlays?.find((o) => o.id === overlayId) as
    | (PersistedOverlay & { keyframes?: unknown })
    | undefined;
}

describe("keyframe tools — add_keyframe", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("omitted properties → snapshots ALL allowed props (rect+opacity+transform3d)", async () => {
    const overlayId = await seedTextOverlay(4);
    const res = await addKeyframe({ pieceId, overlayId, time: 1 } as never);
    expect(res.success).toBe(true);

    const o = await readOverlay(overlayId);
    const kf = (o as { keyframes?: Record<string, { keyframes: { t: number }[] }> }).keyframes!;
    expect(kf).toBeDefined();
    // text kind allows rect, opacity, transform3d.
    expect(kf.rect.keyframes[0].t).toBeCloseTo(0.25); // 1s / 4s
    expect(kf.opacity.keyframes[0].t).toBeCloseTo(0.25);
    expect(kf.transform3d.keyframes[0].t).toBeCloseTo(0.25);
  });

  it("explicit { opacity } keys ONLY the opacity track", async () => {
    const overlayId = await seedTextOverlay(4);
    const res = await addKeyframe({
      pieceId,
      overlayId,
      time: 2,
      properties: { opacity: 0.3 },
    } as never);
    expect(res.success).toBe(true);

    const o = await readOverlay(overlayId);
    const kf = (o as { keyframes?: Record<string, unknown> }).keyframes as Record<
      string,
      { keyframes: { t: number; value: number }[] }
    >;
    expect(Object.keys(kf)).toEqual(["opacity"]);
    expect(kf.opacity.keyframes[0].t).toBeCloseTo(0.5); // 2s / 4s
    expect(kf.opacity.keyframes[0].value).toBe(0.3);
  });

  it("snaps a near edit onto an existing keyframe instead of duplicating it", async () => {
    const overlayId = await seedTextOverlay(4);
    // Keyframe at exactly 1.0s → frame 30 @ 30fps → t = 0.25.
    await addKeyframe({ pieceId, overlayId, time: 1, properties: { opacity: 0.2 } } as never);
    // Edit a third of a frame later (1.01s → frame 30) — must UPDATE the frame-30
    // key, not drop a near-duplicate. This is the core "editing a keyframe just
    // makes another one" fix.
    const res = await addKeyframe({
      pieceId,
      overlayId,
      time: 1.01,
      properties: { opacity: 0.9 },
    } as never);
    expect(res.success).toBe(true);
    const o = await readOverlay(overlayId);
    const keys = (o as { keyframes?: { opacity?: { keyframes: { t: number; value: number }[] } } })
      .keyframes?.opacity?.keyframes;
    expect(keys).toHaveLength(1);
    expect(keys?.[0].value).toBe(0.9);
    expect((res.data as { t: number }).t).toBeCloseTo(0.25, 5); // landed on the existing key
  });

  it("adds a distinct keyframe when the edit is more than half a frame away", async () => {
    const overlayId = await seedTextOverlay(4);
    await addKeyframe({ pieceId, overlayId, time: 1, properties: { opacity: 0.2 } } as never);
    // 1.1s → frame 33 (0.25 apart in frames) → well outside the half-frame snap.
    await addKeyframe({ pieceId, overlayId, time: 1.1, properties: { opacity: 0.9 } } as never);
    const o = await readOverlay(overlayId);
    const keys = (o as { keyframes?: { opacity?: { keyframes: { t: number }[] } } }).keyframes
      ?.opacity?.keyframes;
    expect(keys).toHaveLength(2);
  });

  it("{ position } writes a rect track with base width/height preserved", async () => {
    const overlayId = await seedTextOverlay(4);
    const res = await addKeyframe({
      pieceId,
      overlayId,
      time: 0,
      properties: { position: { x: 200, y: 300 } },
    } as never);
    expect(res.success).toBe(true);

    const o = await readOverlay(overlayId);
    const kf = (o as { keyframes?: Record<string, unknown> }).keyframes as Record<
      string,
      { keyframes: { value: typeof baseRect }[] }
    >;
    expect(Object.keys(kf)).toEqual(["rect"]);
    const rect = kf.rect.keyframes[0].value;
    expect(rect).toEqual({ x: 200, y: 300, width: baseRect.width, height: baseRect.height });
  });

  it("out-of-range time → structured error, no keyframes written", async () => {
    const overlayId = await seedTextOverlay(4);
    const res = await addKeyframe({ pieceId, overlayId, time: 5 } as never);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/out of range/i);

    const o = await readOverlay(overlayId);
    expect((o as { keyframes?: unknown }).keyframes).toBeUndefined();
  });

  it("optional easing is applied to the same keyframe", async () => {
    const overlayId = await seedTextOverlay(4);
    const res = await addKeyframe({
      pieceId,
      overlayId,
      time: 1,
      properties: { opacity: 0.5 },
      easing: "ease-in-out",
    } as never);
    expect(res.success).toBe(true);

    const o = await readOverlay(overlayId);
    const kf = (o as { keyframes?: Record<string, unknown> }).keyframes as Record<
      string,
      { keyframes: { easing?: string }[] }
    >;
    expect(kf.opacity.keyframes[0].easing).toBe("ease-in-out");
  });
});

describe("keyframe tools — tracked overlay (D9 opacity-only)", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
  });
  afterEach(() => cleanupTempDir(tempDir));

  /** Seed a tracked overlay directly (addOverlay can't create this kind). */
  async function seedTrackedOverlay(duration = 4): Promise<string> {
    const id = "ov-tracked-1";
    const overlay = {
      id,
      kind: "tracked",
      startTime: 0,
      duration,
      z: 1,
      opacity: 1,
      rect: baseRect,
      trackId: "trk-1",
      content: { kind: "box" },
    } as unknown as PersistedOverlay;
    await addOverlayToManifest(pieceId, overlay);
    return id;
  }

  it("add_keyframe keys ONLY opacity; rect/position/rotation are dropped", async () => {
    const overlayId = await seedTrackedOverlay(4);
    const res = await addKeyframe({
      pieceId,
      overlayId,
      time: 1,
      properties: {
        opacity: 0.5,
        position: { x: 300, y: 400 },
        rotation: 45,
      },
    } as never);
    expect(res.success).toBe(true);
    expect((res.data as { dropped?: string[] }).dropped).toEqual(
      expect.arrayContaining(["position", "rotation"]),
    );

    const o = await readOverlay(overlayId);
    const kf = (o as { keyframes?: Record<string, unknown> }).keyframes as Record<
      string,
      { keyframes: { value: number }[] }
    >;
    expect(Object.keys(kf)).toEqual(["opacity"]);
    expect(kf.opacity.keyframes[0].value).toBe(0.5);
  });

  it("add_keyframe with omitted properties keys only opacity on a tracked overlay", async () => {
    const overlayId = await seedTrackedOverlay(4);
    const res = await addKeyframe({ pieceId, overlayId, time: 2 } as never);
    expect(res.success).toBe(true);
    const o = await readOverlay(overlayId);
    const kf = (o as { keyframes?: Record<string, unknown> }).keyframes as Record<string, unknown>;
    expect(Object.keys(kf)).toEqual(["opacity"]);
  });
});

describe("keyframe tools — delete_keyframe (individual delete)", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("deleting one key of a 2-key track keeps the lone remaining key", async () => {
    const overlayId = await seedTextOverlay(4);
    // Two opacity keys at 0s and 2s.
    await addKeyframe({ pieceId, overlayId, time: 0, properties: { opacity: 0 } } as never);
    await addKeyframe({ pieceId, overlayId, time: 2, properties: { opacity: 1 } } as never);

    let o = await readOverlay(overlayId);
    const kf = (o as { keyframes?: Record<string, unknown> }).keyframes as Record<
      string,
      { keyframes: unknown[] }
    >;
    expect(kf.opacity.keyframes).toHaveLength(2);

    // Delete the key at 2s → 1 key left → KEPT (individual delete, no collapse).
    const del = await deleteKeyframe({ pieceId, overlayId, time: 2 } as never);
    expect(del.success).toBe(true);

    o = await readOverlay(overlayId);
    const kfAfter = (o as { keyframes?: Record<string, { keyframes: { t: number }[] }> }).keyframes!;
    // The surviving key (t=0) is kept — the track is NOT dropped.
    expect(kfAfter.opacity.keyframes).toHaveLength(1);
    expect(kfAfter.opacity.keyframes[0].t).toBe(0);
  });

  it("deleting at a time with no keyframe → structured error, nothing removed", async () => {
    const overlayId = await seedTextOverlay(4);
    await addKeyframe({ pieceId, overlayId, time: 0, properties: { opacity: 0 } } as never);
    await addKeyframe({ pieceId, overlayId, time: 2, properties: { opacity: 1 } } as never);

    // 1s is between the two keys — no keyframe there.
    const del = await deleteKeyframe({ pieceId, overlayId, time: 1 } as never);
    expect(del.success).toBe(false);
    expect(del.error).toMatch(/no keyframe/i);

    const o = await readOverlay(overlayId);
    const kf = (o as { keyframes?: Record<string, { keyframes: unknown[] }> }).keyframes!;
    expect(kf.opacity.keyframes).toHaveLength(2); // untouched
  });

  it("snaps a hair-off request to the nearest stored key (float round-trip tolerance)", async () => {
    const overlayId = await seedTextOverlay(3);
    // add_keyframe at time=1s on a 3s overlay lands a key at a non-frame-quantized
    // t = 1/3.
    await addKeyframe({ pieceId, overlayId, time: 0, properties: { opacity: 0 } } as never);
    await addKeyframe({ pieceId, overlayId, time: 1, properties: { opacity: 1 } } as never);
    // The end key is at t = 1/3 → seconds = 1. Delete at 1s should resolve it.
    const del = await deleteKeyframe({ pieceId, overlayId, time: 1 } as never);
    expect(del.success).toBe(true);
    const o = await readOverlay(overlayId);
    // The other key (t=0) survives — the delete resolved the non-quantized t=1/3.
    const kf = (o as { keyframes?: Record<string, { keyframes: { t: number }[] }> }).keyframes!;
    expect(kf.opacity.keyframes).toHaveLength(1);
    expect(kf.opacity.keyframes[0].t).toBe(0);
  });
});

describe("keyframe tools — set_keyframe_easing", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("rejects garbage easing", async () => {
    const overlayId = await seedTextOverlay(4);
    await addKeyframe({ pieceId, overlayId, time: 0, properties: { opacity: 0 } } as never);
    const res = await setKeyframeEasing({
      pieceId,
      overlayId,
      time: 0,
      easing: "not-a-real-easing",
    } as never);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/invalid easing/i);
  });

  it("errors when no keyframe exists at the given time (no silent success)", async () => {
    const overlayId = await seedTextOverlay(4);
    // Two opacity keys at 0s and 2s — none at 1s.
    await addKeyframe({ pieceId, overlayId, time: 0, properties: { opacity: 0 } } as never);
    await addKeyframe({ pieceId, overlayId, time: 2, properties: { opacity: 1 } } as never);

    const res = await setKeyframeEasing({
      pieceId,
      overlayId,
      time: 1,
      easing: "ease-in-out",
    } as never);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no keyframe at 1s/i);

    // Nothing was written — neither existing key gained easing.
    const o = await readOverlay(overlayId);
    const kf = (o as { keyframes?: Record<string, unknown> }).keyframes as Record<
      string,
      { keyframes: { easing?: string }[] }
    >;
    expect(kf.opacity.keyframes.every((k) => k.easing === undefined)).toBe(true);
  });

  it("accepts a preset id", async () => {
    const overlayId = await seedTextOverlay(4);
    await addKeyframe({ pieceId, overlayId, time: 0, properties: { opacity: 0 } } as never);
    await addKeyframe({ pieceId, overlayId, time: 2, properties: { opacity: 1 } } as never);
    const res = await setKeyframeEasing({
      pieceId,
      overlayId,
      time: 0,
      easing: "bounce-out",
    } as never);
    expect(res.success).toBe(true);

    const o = await readOverlay(overlayId);
    const kf = (o as { keyframes?: Record<string, unknown> }).keyframes as Record<
      string,
      { keyframes: { t: number; easing?: string }[] }
    >;
    const key0 = kf.opacity.keyframes.find((k) => k.t === 0);
    expect(key0?.easing).toBe("bounce-out");
  });

  it("accepts a cubic-bezier(...) literal", async () => {
    const overlayId = await seedTextOverlay(4);
    await addKeyframe({ pieceId, overlayId, time: 0, properties: { opacity: 0 } } as never);
    await addKeyframe({ pieceId, overlayId, time: 2, properties: { opacity: 1 } } as never);
    const res = await setKeyframeEasing({
      pieceId,
      overlayId,
      time: 0,
      easing: "cubic-bezier(0.1, 0.2, 0.3, 0.4)",
    } as never);
    expect(res.success).toBe(true);

    const o = await readOverlay(overlayId);
    const kf = (o as { keyframes?: Record<string, unknown> }).keyframes as Record<
      string,
      { keyframes: { t: number; easing?: string }[] }
    >;
    const key0 = kf.opacity.keyframes.find((k) => k.t === 0);
    expect(key0?.easing).toBe("cubic-bezier(0.1, 0.2, 0.3, 0.4)");
  });
});

describe("keyframe tools — list_keyframes (seconds)", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("returns times + track times in SECONDS", async () => {
    const overlayId = await seedTextOverlay(4);
    await addKeyframe({ pieceId, overlayId, time: 1, properties: { opacity: 0 } } as never);
    await addKeyframe({ pieceId, overlayId, time: 3, properties: { opacity: 1 } } as never);

    const res = await listKeyframes({ pieceId, overlayId } as never);
    expect(res.success).toBe(true);
    const data = res.data as {
      overlayId: string;
      duration: number;
      times: number[];
      tracks: { opacity?: { time: number }[] };
    };
    expect(data.duration).toBe(4);
    // Stored normalized 0.25 & 0.75 → back to 1s & 3s.
    expect(data.times).toEqual([1, 3]);
    expect(data.tracks.opacity?.map((k) => k.time)).toEqual([1, 3]);
  });

  it("returns empty times for an overlay with no keyframes", async () => {
    const overlayId = await seedTextOverlay(4);
    const res = await listKeyframes({ pieceId, overlayId } as never);
    expect(res.success).toBe(true);
    const data = res.data as { times: number[]; tracks: Record<string, unknown> };
    expect(data.times).toEqual([]);
    expect(data.tracks).toEqual({});
  });
});
