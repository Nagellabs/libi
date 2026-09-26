import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlay } from "@/mcp/tools/overlay-tools";
import { getComposition } from "@/mcp/tools/composition-tools";
import { addOverlayToManifest, type PersistedOverlay } from "@/lib/composition/persistence";

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

const pieceId = "piece-getcomp";
const rect = { x: 0, y: 0, width: 100, height: 50 };
const DRAW_BODY = "const { ctx } = context;\nctx.fillText('MARKER_DRAW', 10, 10);";
const SCENE_BODY = "scene.add(new THREE.Mesh()); // MARKER_SCENE";
const TRACKED_BODY = "const { ctx } = context; ctx.fillText('MARKER_TRACKED', 0, 0);";

type Rec = Record<string, unknown> & { id: string; codeFilePath?: string };

function overlaysOf(data: unknown): Rec[] {
  return ((data as { manifest: { overlays?: Rec[] } }).manifest.overlays ?? []);
}

describe("get_composition", () => {
  beforeEach(() => { tempDir = createTempStorageDir(); });
  afterEach(() => cleanupTempDir(tempDir));

  it("returns codeFilePath instead of inline code for every code-bearing overlay kind", async () => {
    const storage = new LocalFileStorage(tempDir);
    const code = await addOverlay({ pieceId, kind: "code", displayName: "C", startTime: 0, duration: 2, rect, z: 0, opacity: 1, body: DRAW_BODY });
    const three = await addOverlay({ pieceId, kind: "three", displayName: "T", startTime: 0, duration: 2, rect, z: 1, opacity: 1, body: SCENE_BODY });
    const text = await addOverlay({ pieceId, kind: "text", startTime: 0, duration: 2, rect, z: 2, opacity: 1, content: "hello", font: "20px sans", color: "#fff", align: "center" });
    const tracked: PersistedOverlay = {
      id: "tracked-1", kind: "tracked", trackId: "t1", startTime: 0, duration: 2, rect, z: 3, opacity: 1,
      content: { kind: "code", drawFunction: TRACKED_BODY }, fit: "tight", scale: 1, smoothing: "linear",
    } as PersistedOverlay;
    await addOverlayToManifest(pieceId, tracked);
    const codeId = (code.data as { overlayId: string }).overlayId;
    const threeId = (three.data as { overlayId: string }).overlayId;
    const textId = (text.data as { overlayId: string }).overlayId;

    const res = await getComposition({ pieceId });
    expect(res.success).toBe(true);

    // No code body anywhere in the payload.
    const json = JSON.stringify(res.data);
    expect(json).not.toContain("MARKER_DRAW");
    expect(json).not.toContain("MARKER_SCENE");
    expect(json).not.toContain("MARKER_TRACKED");

    const byId = new Map(overlaysOf(res.data).map((o) => [o.id, o]));
    const c = byId.get(codeId)!;
    expect(c.codeFilePath).toBe(storage.localPath(pieceId, `overlays/${codeId}/draw.jsx`));
    expect(c).not.toHaveProperty("drawFunction");
    expect(c.kind).toBe("code");

    const t = byId.get(threeId)!;
    expect(t.codeFilePath).toBe(storage.localPath(pieceId, `overlays/${threeId}/scene.jsx`));
    expect(t).not.toHaveProperty("sceneFunction");

    const tr = byId.get("tracked-1")!;
    expect(tr.codeFilePath).toBe(storage.localPath(pieceId, "overlays/tracked-1/content.jsx"));
    expect(tr.content).toEqual({ kind: "code" });

    // Non-code overlays are untouched (text keeps its content string, no path).
    const tx = byId.get(textId)!;
    expect(tx.content).toBe("hello");
    expect(tx).not.toHaveProperty("codeFilePath");

    // The path the agent is handed holds the body it would have read inline.
    expect((await storage.read(pieceId, `overlays/${codeId}/draw.jsx`)).toString("utf-8")).toContain("MARKER_DRAW");
  });

  it("keeps the rest of the manifest (dimensions, audio) intact", async () => {
    await addOverlay({ pieceId, kind: "code", displayName: "C", startTime: 0, duration: 2, rect, z: 0, opacity: 1, body: DRAW_BODY });
    const res = await getComposition({ pieceId });
    const m = (res.data as { manifest: Record<string, unknown> }).manifest;
    expect(m).toHaveProperty("width");
    expect(m).toHaveProperty("height");
    expect(m).toHaveProperty("fps");
  });
});
