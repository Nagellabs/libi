import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveOverlayPreset } from "@/mcp/tools/overlay-preset-tools";
import { listUserPresets } from "@/lib/overlays/preset-store";

// saveOverlayPreset reads the overlay from the manifest + writes to
// ~/.libi/overlay-presets. Point LIBI_HOME at a temp dir and seed a manifest.
import { saveManifest, loadManifest } from "@/lib/composition/persistence";

let home: string;
const PIECE = "piece-presets-test";

async function seedOverlay() {
  const manifest = await loadManifest(PIECE);
  manifest.overlays = [
    {
      id: "ov1", kind: "text", content: "Hi",
      rect: { x: 0, y: 0, w: 0.5, h: 0.2 }, startTime: 0, duration: 2, z: 0,
      color: "#ff0000", reveal: { mode: "pop" },
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0.5 } },
    } as never,
  ];
  await saveManifest(PIECE, manifest);
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "libi-preset-"));
  process.env.LIBI_HOME = home;
  await seedOverlay();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.LIBI_HOME;
});

describe("saveOverlayPreset — name uniqueness + override", () => {
  it("saves a new preset and captures the FULL overlay (incl reveal + transform3d)", async () => {
    const r = await saveOverlayPreset({ pieceId: PIECE, overlayId: "ov1", name: "My Look" });
    expect(r.success).toBe(true);
    expect(r.data?.presetId).toBe("my-look");
    const saved = (await listUserPresets()).find((p) => p.id === "my-look")!;
    expect(saved.fields.reveal).toEqual({ mode: "pop" });
    expect((saved.fields.transform3d as { rotation: { z: number } }).rotation.z).toBe(0.5);
    // A fresh save stamps both timestamps.
    expect(typeof saved.createdAt).toBe("string");
    expect(typeof saved.updatedAt).toBe("string");
  });

  it("a second save with the SAME name (no override) returns preset_name_exists", async () => {
    await saveOverlayPreset({ pieceId: PIECE, overlayId: "ov1", name: "My Look" });
    const r = await saveOverlayPreset({ pieceId: PIECE, overlayId: "ov1", name: "My Look" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("preset_name_exists");
    expect(r.data?.presetId).toBe("my-look");
    // still exactly one preset on disk
    expect((await listUserPresets()).filter((p) => p.id === "my-look")).toHaveLength(1);
  });

  it("override:true overwrites fields + preserves createdAt (keeps updatedAt)", async () => {
    await saveOverlayPreset({ pieceId: PIECE, overlayId: "ov1", name: "My Look" });
    const before = (await listUserPresets()).find((p) => p.id === "my-look")!;
    // mutate the overlay then re-save with override
    const m = await loadManifest(PIECE);
    (m.overlays![0] as Record<string, unknown>).color = "#00ff00";
    await saveManifest(PIECE, m);
    const r = await saveOverlayPreset({ pieceId: PIECE, overlayId: "ov1", name: "My Look", override: true });
    expect(r.success).toBe(true);
    expect(r.data?.presetId).toBe("my-look");
    const saved = (await listUserPresets()).filter((p) => p.id === "my-look");
    expect(saved).toHaveLength(1);
    expect(saved[0].fields.color).toBe("#00ff00");
    // createdAt is preserved across an override; updatedAt is still present.
    expect(saved[0].createdAt).toBe(before.createdAt);
    expect(typeof saved[0].updatedAt).toBe("string");
  });

  it("a name colliding with a BUNDLED look is reserved (cannot override)", async () => {
    const r = await saveOverlayPreset({ pieceId: PIECE, overlayId: "ov1", name: "Clean", override: true });
    expect(r.success).toBe(false);
    expect(r.error).toBe("preset_name_reserved");
  });
});
