/**
 * Task 3.1 — MCP overlay-preset tools (save / list / apply / delete).
 *
 * Mirrors the seeding pattern of `overlay-update-transform.test.ts` (temp
 * storage dir mocked via `@/lib/storage`, overlays seeded with `addOverlay`,
 * read back via `loadManifest`). `createTempStorageDir()` also sets
 * `process.env.LIBI_HOME` to that temp dir, so the preset-store (which reads
 * `getLibiHome()`) writes its JSON files there — no extra env wiring needed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { LocalFileStorage } from "@/lib/storage/local";
import { addOverlay } from "@/mcp/tools/overlay-tools";
import {
  saveOverlayPreset,
  listOverlayPresets,
  applyOverlayPreset,
  deleteOverlayPreset,
} from "@/mcp/tools/overlay-preset-tools";
import { loadManifest } from "@/lib/composition/persistence";

const baseRect = { x: 0, y: 0, width: 200, height: 80 };

let tempDir: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => new LocalFileStorage(tempDir),
}));

const pieceId = "piece-overlay-presets-test";

async function addStyledText(): Promise<string> {
  const add = await addOverlay({
    pieceId,
    kind: "text",
    startTime: 0,
    duration: 3,
    rect: baseRect,
    z: 1,
    opacity: 1,
    content: "Gold",
    font: "48px Inter",
    color: "#ffd400",
    align: "center",
    stroke: { color: "#000000", width: 6 },
    reveal: { mode: "pop" },
  } as never);
  expect(add.success).toBe(true);
  return (add.data as { overlayId: string }).overlayId;
}

async function addPlainText(): Promise<string> {
  const add = await addOverlay({
    pieceId,
    kind: "text",
    startTime: 0,
    duration: 2,
    rect: baseRect,
    z: 0,
    opacity: 1,
    content: "Plain",
    font: "48px Inter",
    color: "#ffffff",
    align: "left",
  } as never);
  expect(add.success).toBe(true);
  return (add.data as { overlayId: string }).overlayId;
}

describe("overlay-preset MCP tools", () => {
  beforeEach(() => {
    tempDir = createTempStorageDir();
  });
  afterEach(() => cleanupTempDir(tempDir));

  it("saves, lists, applies, and deletes a user preset", async () => {
    // 1. Seed a styled text overlay and save its look as a preset.
    const styledId = await addStyledText();
    const save = await saveOverlayPreset({ pieceId, overlayId: styledId, name: "Gold Look" });
    expect(save.success).toBe(true);
    const presetId = (save.data as { presetId: string }).presetId;
    expect(presetId).toBe("gold-look"); // slugified from the name

    // 2. The preset shows up in the text-kind list.
    const listed = await listOverlayPresets({ kind: "text" });
    expect(listed.success).toBe(true);
    const ids = (listed.data as { presets: { id: string }[] }).presets.map((p) => p.id);
    expect(ids).toContain(presetId);

    // 3. Apply onto a SECOND plain overlay → its captured style fields appear.
    const plainId = await addPlainText();
    const apply = await applyOverlayPreset({ pieceId, overlayId: plainId, presetId });
    expect(apply.success).toBe(true);

    const manifest = await loadManifest(pieceId);
    const target = manifest.overlays?.find((o) => o.id === plainId) as
      | Record<string, unknown>
      | undefined;
    expect(target).toBeDefined();
    // The preset merged the styled overlay's color/stroke/reveal onto the plain one.
    expect(target!.color).toBe("#ffd400");
    expect(target!.stroke).toEqual({ color: "#000000", width: 6 });
    expect(target!.reveal).toEqual({ mode: "pop" });

    // 4. Delete the user preset → it no longer appears in the list.
    const del = await deleteOverlayPreset({ presetId });
    expect(del.success).toBe(true);

    const afterList = await listOverlayPresets({ kind: "text" });
    const afterIds = (afterList.data as { presets: { id: string }[] }).presets.map((p) => p.id);
    expect(afterIds).not.toContain(presetId);
  });

  it("returns overlay_not_found when saving a missing overlay", async () => {
    const res = await saveOverlayPreset({ pieceId, overlayId: "nope", name: "X" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("overlay_not_found");
  });

  it("returns preset_not_found when applying an unknown preset", async () => {
    const id = await addPlainText();
    const res = await applyOverlayPreset({ pieceId, overlayId: id, presetId: "does-not-exist" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("preset_not_found");
  });

  it("reserves a name that collides with a bundled look id (no override)", async () => {
    // "Pop" slugifies to "pop", a bundled look id → reserved, cannot be saved.
    const styledId = await addStyledText();
    const save = await saveOverlayPreset({ pieceId, overlayId: styledId, name: "Pop" });
    expect(save.success).toBe(false);
    expect(save.error).toBe("preset_name_reserved");
  });
});
