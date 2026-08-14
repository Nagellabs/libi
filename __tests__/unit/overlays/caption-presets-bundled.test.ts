import { describe, it, expect } from "vitest";
import { BUNDLED_OVERLAY_PRESETS } from "@/lib/overlays/caption-presets";

describe("BUNDLED_OVERLAY_PRESETS", () => {
  it("exposes each CAPTION_PRESET as a text-kind bundled OverlayPreset", () => {
    expect(BUNDLED_OVERLAY_PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const p of BUNDLED_OVERLAY_PRESETS) {
      expect(p.kind).toBe("text");
      expect(p.source).toBe("bundled");
      expect(typeof p.id).toBe("string");
      expect(typeof p.name).toBe("string");
      expect(p.fields && typeof p.fields).toBe("object");
    }
    const clean = BUNDLED_OVERLAY_PRESETS.find((p) => p.id === "clean");
    expect(clean?.fields.color).toBe("#ffffff");
  });
});
