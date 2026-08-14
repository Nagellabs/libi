import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlay, updateOverlay, getOverlays, removeOverlayTool } from "@/mcp/tools/overlay-tools";
import type { ToolResult } from "@/mcp/tools/types";

const baseRect = { x: 0, y: 0, width: 100, height: 50 };

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

const pieceId = "piece1";

/** Shape of the records get_overlays returns (manifest overlay minus code bodies, plus codeFilePath). */
type OverlayListRecord = {
  id: string;
  z?: number;
  fontSize?: number;
  codeFilePath?: string;
  stroke?: { color: string; width: number };
  background?: { color: string; padding?: number };
  reveal?: { mode: string };
  transform3d?: unknown;
};

function overlayIdOf(res: ToolResult): string {
  return (res.data as { overlayId: string }).overlayId;
}

function findOverlay(res: ToolResult, overlayId: string): OverlayListRecord {
  const { overlays } = res.data as { overlays: OverlayListRecord[] };
  const rec = overlays.find((o) => o.id === overlayId);
  if (!rec) throw new Error(`overlay ${overlayId} not in get_overlays result`);
  return rec;
}

describe("consolidated overlay tools", () => {
  beforeEach(() => { tempDir = createTempStorageDir(); });
  afterEach(() => cleanupTempDir(tempDir));

  it("adds a three overlay, scaffolds scene.jsx, returns its path", async () => {
    const res = await addOverlay({ pieceId, kind: "three", displayName: "Test", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1, body: "scene.add(mesh)" });
    expect(res.success).toBe(true);
    const overlayId = overlayIdOf(res);
    const codeFilePath = (res.data as { codeFilePath: string }).codeFilePath;
    expect(codeFilePath).toBe(`overlays/${overlayId}/scene.jsx`);
    expect(await new LocalFileStorage(tempDir).exists(pieceId, codeFilePath)).toBe(true);
  });

  it("scaffolds a starter body when none is given", async () => {
    const res = await addOverlay({ pieceId, kind: "code", displayName: "Test", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1 });
    const overlayId = overlayIdOf(res);
    const body = (await new LocalFileStorage(tempDir).read(pieceId, `overlays/${overlayId}/draw.jsx`)).toString("utf-8");
    expect(body.length).toBeGreaterThan(0);
  });

  it("update_overlay moves the rect (structured door, no file)", async () => {
    const add = await addOverlay({ pieceId, kind: "text", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1, content: "hi", font: "20px sans", color: "#fff", align: "center" });
    const overlayId = overlayIdOf(add);
    const up = await updateOverlay({ pieceId, overlayId, rect: { x: 5, y: 5, width: 80, height: 40 }, z: 2 });
    expect(up.success).toBe(true);
    const rec = findOverlay(await getOverlays({ pieceId }), overlayId);
    expect(rec.z).toBe(2);
  });

  it("get_overlays returns records + code file paths", async () => {
    const add = await addOverlay({ pieceId, kind: "three", displayName: "Test", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1, body: "scene.add(x)" });
    const overlayId = overlayIdOf(add);
    const rec = findOverlay(await getOverlays({ pieceId }), overlayId);
    expect(rec.codeFilePath).toBe(`overlays/${overlayId}/scene.jsx`);
  });

  it("remove deletes the overlay dir", async () => {
    const add = await addOverlay({ pieceId, kind: "three", displayName: "Test", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1, body: "scene.add(x)" });
    const overlayId = overlayIdOf(add);
    await removeOverlayTool({ pieceId, overlayId });
    expect(await new LocalFileStorage(tempDir).exists(pieceId, `overlays/${overlayId}/scene.jsx`)).toBe(false);
  });

  it("add_text_overlay persists styling (stroke) on the overlay", async () => {
    const add = await addOverlay({
      pieceId, kind: "text", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1,
      content: "hi", font: "20px sans", color: "#fff", align: "center",
      stroke: { color: "#000", width: 6 },
    });
    expect(add.success).toBe(true);
    const overlayId = overlayIdOf(add);
    const rec = findOverlay(await getOverlays({ pieceId }), overlayId);
    expect(rec.stroke).toEqual({ color: "#000", width: 6 });
  });

  it("update_overlay persists + round-trips styling (background + reveal)", async () => {
    const add = await addOverlay({
      pieceId, kind: "text", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1,
      content: "hi", font: "20px sans", color: "#fff", align: "center",
    });
    const overlayId = overlayIdOf(add);

    const up = await updateOverlay({
      pieceId, overlayId,
      background: { color: "#000" },
      reveal: { mode: "typewriter" },
    });
    expect(up.success).toBe(true);

    const rec = findOverlay(await getOverlays({ pieceId }), overlayId);
    expect(rec.background).toEqual({ color: "#000" });
    expect(rec.reveal).toEqual({ mode: "typewriter" });
  });

  it("update_overlay does not write undefined over existing styling", async () => {
    const add = await addOverlay({
      pieceId, kind: "text", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1,
      content: "hi", font: "20px sans", color: "#fff", align: "center",
      fontSize: 64,
    });
    const overlayId = overlayIdOf(add);

    // A patch that touches an unrelated field must leave fontSize intact.
    await updateOverlay({ pieceId, overlayId, z: 3 });
    const rec = findOverlay(await getOverlays({ pieceId }), overlayId);
    expect(rec.fontSize).toBe(64);
  });

  it("add three overlay persists transform3d on the overlay", async () => {
    const t3d = {
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0.5, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
    const add = await addOverlay({
      pieceId, kind: "three", displayName: "Test", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1,
      body: "scene.add(x)", transform3d: t3d,
    });
    expect(add.success).toBe(true);
    const overlayId = overlayIdOf(add);
    const rec = findOverlay(await getOverlays({ pieceId }), overlayId);
    expect(rec.transform3d).toEqual(t3d);
  });

  it("update_overlay round-trips transform3d on an existing three overlay", async () => {
    const add = await addOverlay({
      pieceId, kind: "three", displayName: "Test", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1,
      body: "scene.add(x)",
    });
    const overlayId = overlayIdOf(add);

    const t3d = {
      position: { x: 5, y: -5, z: 0 },
      rotation: { x: 1, y: 0, z: -1 },
      scale: { x: 2, y: 2, z: 2 },
    };
    const up = await updateOverlay({ pieceId, overlayId, transform3d: t3d });
    expect(up.success).toBe(true);

    const rec = findOverlay(await getOverlays({ pieceId }), overlayId);
    expect(rec.transform3d).toEqual(t3d);
  });

  it("update_overlay clears a styling key via the null sentinel", async () => {
    const add = await addOverlay({
      pieceId, kind: "text", startTime: 0, duration: 2, rect: baseRect, z: 0, opacity: 1,
      content: "hi", font: "20px sans", color: "#fff", align: "center",
      background: { color: "#000", padding: 12 },
    });
    const overlayId = overlayIdOf(add);

    // Sanity: the background is present after add.
    let rec = findOverlay(await getOverlays({ pieceId }), overlayId);
    expect(rec.background).toEqual({ color: "#000", padding: 12 });

    // null DELETEs the key — after reload the field is gone.
    const cleared = await updateOverlay({ pieceId, overlayId, background: null });
    expect(cleared.success).toBe(true);
    rec = findOverlay(await getOverlays({ pieceId }), overlayId);
    expect(rec.background).toBeUndefined();
    expect("background" in rec).toBe(false);

    // A subsequent object patch sets it again.
    await updateOverlay({ pieceId, overlayId, background: { color: "#fff" } });
    rec = findOverlay(await getOverlays({ pieceId }), overlayId);
    expect(rec.background).toEqual({ color: "#fff" });
  });
});
