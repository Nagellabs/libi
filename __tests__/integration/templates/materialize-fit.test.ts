/* eslint-disable @typescript-eslint/no-explicit-any -- reads back loosely-typed manifest JSON */
/**
 * `applyScaffold` fitting a template into a piece of another shape (fit: "reflow"), plus the
 * per-layer controls an agent uses instead of restyling afterwards: layerOverrides, omitLayers,
 * startAt. The template is a 16:9 card with a keyframed wordmark; the piece is 9:16.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { loadManifest, saveManifest, type PersistedOverlay } from "@/lib/composition/persistence";

let testDb: ReturnType<typeof createTestDb>;
let storageDir: string;
vi.mock("@/lib/db/client", () => ({ getDb: () => testDb }));
vi.mock("@/lib/storage", () => ({ getStorage: async () => new LocalFileStorage(storageDir) }));
vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(async () => ({ status: "new", jobId: "j", clientKey: "k" })),
  LibiServerUnavailableError: class extends Error {},
  logProxyGenEnqueueFailure: () => {},
}));

import { createTemplate } from "@/lib/templates/store";
import { applyScaffold, type UrlFetcher } from "@/lib/templates/materialize";
import type { TemplateScaffold } from "@/lib/templates/scaffold";

const noUrls: UrlFetcher = async (urls) => urls.map((url) => ({ url, error: "unexpected fetch" }));

const WORDMARK_BASE = { x: 360, y: 440, width: 1200, height: 200 };

function landscapeScaffold(): TemplateScaffold {
  const common = { opacity: 1 };
  return {
    schema: 1,
    name: "Landscape card",
    description: "d",
    tags: ["t"],
    canvas: { width: 1920, height: 1080, fps: 30 },
    duration: 6,
    slots: [
      { key: "backdrop-img", kind: "image", label: "Backdrop", required: false },
      { key: "logo-img", kind: "image", label: "Logo", required: false },
      { key: "command", kind: "text", label: "Command", required: false },
    ],
    overlays: [
      { key: "backdrop", kind: "image", startTime: 0, duration: 6, rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 0, ...common, source: { slot: "backdrop-img" } },
      { key: "logo", kind: "image", startTime: 0, duration: 6, rect: { x: 1700, y: 40, width: 160, height: 160 }, z: 1, ...common, source: { slot: "logo-img" } },
      {
        key: "wordmark",
        kind: "text",
        startTime: 1,
        duration: 4,
        rect: WORDMARK_BASE,
        z: 2,
        ...common,
        text: { fixed: "libi" },
        font: "800 120px Inter",
        fontSize: 120,
        color: "#ffffff",
        align: "center",
        anchor: "mid-center",
        position: { x: 960, y: 540 },
        shadow: { color: "#000000", blur: 20, dx: 0, dy: 8 },
        keyframes: {
          rect: {
            keyframes: [
              { t: 0, value: { x: 360, y: 640, width: 1200, height: 200 } },
              { t: 1, value: WORDMARK_BASE },
            ],
          },
          opacity: { keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
        },
      },
      { key: "command", kind: "text", startTime: 2, duration: 3, rect: { x: 360, y: 800, width: 1200, height: 100 }, z: 3, ...common, text: { slot: "command" }, font: "500 40px Inter", color: "#cccccc", align: "center" },
      { key: "fx", kind: "code", startTime: 0, duration: 6, rect: { x: 0, y: 0, width: 1920, height: 1080 }, z: 4, ...common, codeFile: "overlays/fx/draw.jsx" },
    ],
    audioClips: [],
    assets: [],
    fonts: [],
    captionStyles: [],
  } as unknown as TemplateScaffold;
}

describe("applyScaffold fit / layerOverrides / omitLayers / startAt", () => {
  let templateId: string;
  /** A non-empty 9:16 piece, so the template's canvas does not replace its own. */
  const portraitPiece = async (id = "dst") => {
    const pieceId = seedPiece(testDb, { id });
    await saveManifest(pieceId, {
      width: 1080,
      height: 1920,
      fps: 30,
      overlays: [{ id: "base-text", kind: "text", startTime: 0, duration: 8, rect: { x: 0, y: 0, width: 1080, height: 100 }, z: 0, opacity: 1, content: "x", font: "40px Inter", color: "#fff", align: "left" } as PersistedOverlay],
    } as never);
    return pieceId;
  };
  const apply = (pieceId: string, extra: Partial<Parameters<typeof applyScaffold>[0]> = {}) =>
    applyScaffold({ templateId, pieceId, fetchUrls: noUrls, ...extra });
  const overlayOf = async (pieceId: string, id: string) => (await loadManifest(pieceId)).overlays!.find((o) => o.id === id) as unknown as Record<string, any>;

  beforeEach(async () => {
    storageDir = createTempStorageDir();
    testDb = createTestDb();
    templateId = (
      await createTemplate({
        name: "Landscape card",
        description: "d",
        tags: ["t"],
        scaffold: landscapeScaffold(),
        instructions: "# Purpose\n",
        copies: [],
        writes: [{ rel: "overlays/fx/draw.jsx", body: "const { ctx } = context;\nctx.fillStyle = '#f00';\nctx.fillRect(0, 0, 50, 50);" }],
      })
    ).id;
  });
  afterEach(() => {
    resetTestDb();
    cleanupTempDir(storageDir);
  });

  it("reflows by default into a piece of another shape, reports what it placed, and keeps the piece's own canvas", async () => {
    const dst = await portraitPiece();
    const r = await apply(dst);
    const m = await loadManifest(dst);
    expect([m.width, m.height]).toEqual([1080, 1920]);
    expect(r.fit).toEqual({ mode: "reflow", from: "1920×1080", to: "1080×1920", scale: 1 });
    // No "may need repositioning" nag: the apply did that.
    expect(r.warnings.some((w) => w.includes("may need repositioning"))).toBe(false);

    const backdrop = await overlayOf(dst, r.overlays.backdrop!);
    expect(backdrop.rect).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    const logo = await overlayOf(dst, r.overlays.logo!);
    expect(logo.rect).toEqual({ x: 860, y: 40, width: 160, height: 160 });

    const wm = await overlayOf(dst, r.overlays.wordmark!);
    expect(wm.fontSize).toBeCloseTo(97.2, 5); // 120 × 0.81: 1200 px wide became 972
    expect(wm.font).toBe("800 97.2px Inter");
    expect(wm.position).toEqual({ x: 540, y: 960 });
    expect(wm.keyframes.rect.keyframes[0].value).toEqual({ x: 54, y: 1041, width: 972, height: 162 });
    expect(wm.keyframes.rect.keyframes[1].value).toEqual({ x: 54, y: 879, width: 972, height: 162 });
    expect(wm.keyframes.opacity.keyframes).toHaveLength(2);

    // The compact placed list is read back after the save, one entry per layer, with timing.
    expect(r.placed.map((p) => p.layer)).toEqual(["backdrop", "logo", "wordmark", "command", "fx"]);
    const placedWm = r.placed.find((p) => p.layer === "wordmark")!;
    expect(placedWm).toMatchObject({ overlayId: r.overlays.wordmark, kind: "text", start: 1, end: 5 });
    expect(placedWm.rect.width).toBeGreaterThan(0);
    // The code layer is flagged for a look.
    expect(r.warnings.some((w) => w.includes('layer "fx"') && w.includes("1920×1080"))).toBe(true);
  });

  it("fit 'none' keeps today's behaviour: layers at their authored pixels and the repositioning warning", async () => {
    const dst = await portraitPiece();
    const r = await apply(dst, { fit: "none" });
    expect(r.fit).toBeUndefined();
    expect((await overlayOf(dst, r.overlays.logo!)).rect).toEqual({ x: 1700, y: 40, width: 160, height: 160 });
    expect(r.warnings.some((w) => w.includes("may need repositioning"))).toBe(true);
  });

  it("does nothing to layers when the frames match", async () => {
    const dst = seedPiece(testDb, { id: "land" });
    await saveManifest(dst, { width: 1920, height: 1080, fps: 30, overlays: [{ id: "b", kind: "text", startTime: 0, duration: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, z: 0, opacity: 1, content: "x", font: "10px Inter", color: "#fff", align: "left" }] } as never);
    const r = await apply(dst);
    expect(r.fit).toBeUndefined();
    expect((await overlayOf(dst, r.overlays.logo!)).rect).toEqual({ x: 1700, y: 40, width: 160, height: 160 });
  });

  it("an empty piece takes the template's canvas, unless reflow is asked for", async () => {
    const empty = seedPiece(testDb, { id: "empty-1" });
    const a = await apply(empty);
    expect(a.fit).toBeUndefined();
    const am = await loadManifest(empty);
    expect([am.width, am.height]).toEqual([1920, 1080]);

    const empty2 = seedPiece(testDb, { id: "empty-2" });
    await saveManifest(empty2, { width: 1080, height: 1920, fps: 30, overlays: [] } as never);
    const b = await apply(empty2, { fit: "reflow" });
    const bm = await loadManifest(empty2);
    expect([bm.width, bm.height]).toEqual([1080, 1920]);
    expect(b.fit?.to).toBe("1080×1920");
    expect((await overlayOf(empty2, b.overlays.logo!)).rect).toEqual({ x: 860, y: 40, width: 160, height: 160 });
  });

  it("layerOverrides set fields on a layer as it is placed; a rect override takes the keyframes along; null clears", async () => {
    const dst = await portraitPiece();
    const r = await apply(dst, {
      layerOverrides: {
        wordmark: { color: "#ff0066", shadow: null as never, rect: { x: 100, y: 300, width: 880, height: 120 }, fontSize: 70 },
        command: { opacity: 0.5, displayName: "Install" },
      },
    });
    const wm = await overlayOf(dst, r.overlays.wordmark!);
    expect(wm.color).toBe("#ff0066");
    expect(wm.shadow).toBeUndefined();
    expect(wm.fontSize).toBe(70);
    // The override's rect is the placement; the keyframes follow from the reflowed rect onto it.
    expect(wm.keyframes.rect.keyframes[1].value).toEqual({ x: 100, y: 300, width: 880, height: 120 });
    const slide = wm.keyframes.rect.keyframes[0].value;
    expect(slide.x).toBeCloseTo(100, 1);
    expect(slide.y).toBeGreaterThan(300);
    // A point-text overlay keeps its point inside the overridden box.
    expect(wm.position.x).toBeCloseTo(540, 0);
    const cmd = await overlayOf(dst, r.overlays.command!);
    expect(cmd).toMatchObject({ opacity: 0.5, displayName: "Install" });
  });

  it("refuses overrides naming an unknown layer, an omitted layer or a field the kind lacks - before writing anything", async () => {
    const dst = await portraitPiece();
    await expect(apply(dst, { layerOverrides: { ghost: { opacity: 1 } } })).rejects.toThrow(/layer_unknown: ghost \(layers: backdrop, logo, wordmark/);
    await expect(apply(dst, { omitLayers: ["ghost"] })).rejects.toThrow(/layer_unknown: ghost/);
    await expect(apply(dst, { omitLayers: ["logo"], layerOverrides: { logo: { opacity: 1 } } })).rejects.toThrow(/layer_override_omitted: logo/);
    await expect(apply(dst, { layerOverrides: { logo: { color: "#fff" } } })).rejects.toThrow(/layer_override_invalid: logo: a image layer has no color \(text layers only\)/);
    expect((await loadManifest(dst)).overlays).toHaveLength(1);
  });

  it("omitLayers skips the layer and a slot only it used is not reported unfilled", async () => {
    const dst = await portraitPiece();
    const r = await apply(dst, { omitLayers: ["backdrop", "logo"], slotValues: { "logo-img": "https://example.com/l.png" } });
    expect(Object.keys(r.overlays).sort()).toEqual(["command", "fx", "wordmark"]);
    expect((await loadManifest(dst)).overlays).toHaveLength(4);
    expect(r.unfilledSlots.map((s) => s.key)).toEqual(["command"]);
    expect(r.warnings.some((w) => w.includes('slot "logo-img" was given, but the only layer using it is in omitLayers'))).toBe(true);
  });

  it("startAt shifts every layer's timeline; an override's startTime is absolute", async () => {
    const dst = await portraitPiece();
    const r = await apply(dst, { startAt: 73.5, layerOverrides: { fx: { startTime: 80 } } });
    const byLayer = Object.fromEntries(r.placed.map((p) => [p.layer, p]));
    expect(byLayer.wordmark).toMatchObject({ start: 74.5, end: 78.5 });
    expect(byLayer.command).toMatchObject({ start: 75.5, end: 78.5 });
    expect(byLayer.backdrop).toMatchObject({ start: 73.5, end: 79.5 });
    expect(byLayer.fx).toMatchObject({ start: 80, end: 86 });
  });
});
