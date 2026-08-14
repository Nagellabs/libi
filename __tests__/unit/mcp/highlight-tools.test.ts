import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock notify so we can assert calls without a running server.
const highlightSpy = vi.fn();
const setModeSpy = vi.fn();
vi.mock("@/mcp/notify", () => ({
  notify: {
    highlight: (...args: unknown[]) => highlightSpy(...args),
    setComplexityMode: (...args: unknown[]) => setModeSpy(...args),
  },
}));

// Mock the manifest so the handler can resolve the target overlay's KIND
// without disk/DB. Tests mutate `manifestOverlays` per case.
const manifestOverlays: Array<{ id: string; kind: string }> = [];
vi.mock("@/lib/composition/persistence", () => ({
  loadManifest: vi.fn(async () => ({ overlays: manifestOverlays })),
}));

import { highlightProperty, setComplexityMode } from "@/mcp/tools/navigation-tools";
import {
  highlightPropertySchema,
  setComplexityModeSchema,
} from "@/mcp/tools/schemas";
import { fieldKeysForKind } from "@/lib/overlays/inspector-fields";

beforeEach(() => {
  highlightSpy.mockClear();
  setModeSpy.mockClear();
  manifestOverlays.length = 0;
  manifestOverlays.push({ id: "ov1", kind: "text" });
});

describe("highlightProperty", () => {
  it("rejects an unknown property without calling notify", async () => {
    const result = await highlightProperty({
      pieceId: "p1",
      overlayId: "ov1",
      property: "does.not.exist",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("unknown_property");
    expect(Array.isArray(result.data?.validKeys)).toBe(true);
    expect((result.data?.validKeys as string[]).length).toBeGreaterThan(0);
    expect(highlightSpy).not.toHaveBeenCalled();
  });

  it("accepts a known property, calls notify.highlight, returns bumpedModeTo", async () => {
    const result = await highlightProperty({
      pieceId: "p1",
      overlayId: "ov1",
      property: "background.color",
      note: "make it pop",
    });
    expect(result.success).toBe(true);
    expect(result.data?.highlighted).toBe(true);
    expect(result.data?.kind).toBe("text");
    // background.color is in the style group (for text)
    expect(result.data?.bumpedModeTo).toBe("style");
    expect(highlightSpy).toHaveBeenCalledTimes(1);
    expect(highlightSpy).toHaveBeenCalledWith({
      pieceId: "p1",
      overlayId: "ov1",
      property: "background.color",
      note: "make it pop",
    });
  });

  it("rejects a key that exists for ANOTHER kind but not the target overlay's kind", async () => {
    manifestOverlays.length = 0;
    manifestOverlays.push({ id: "ov1", kind: "tracked" });
    // transformPosX exists for text — but tracked has no such field (its
    // placement comes from the track, not a rect). Pre-fix this "succeeded"
    // server-side and silently no-op'd client-side.
    const result = await highlightProperty({
      pieceId: "p1",
      overlayId: "ov1",
      property: "transformPosX",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("property_not_applicable");
    expect(result.data?.kind).toBe("tracked");
    expect(result.data?.validKeys).toEqual(fieldKeysForKind("tracked"));
    expect(highlightSpy).not.toHaveBeenCalled();
  });

  it("accepts a tracked-applicable key on a tracked overlay (kind-aware bump)", async () => {
    manifestOverlays.length = 0;
    manifestOverlays.push({ id: "ov1", kind: "tracked" });
    const result = await highlightProperty({
      pieceId: "p1",
      overlayId: "ov1",
      property: "offsetX",
    });
    expect(result.success).toBe(true);
    expect(result.data?.kind).toBe("tracked");
    expect(result.data?.bumpedModeTo).toBe("transform");
    expect(highlightSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown overlay id with overlay_not_found", async () => {
    const result = await highlightProperty({
      pieceId: "p1",
      overlayId: "nope",
      property: "background.color",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("overlay_not_found");
    expect(highlightSpy).not.toHaveBeenCalled();
  });
});

describe("setComplexityMode", () => {
  it("calls notify.setComplexityMode with the targeted overlay + mode", async () => {
    const result = await setComplexityMode({
      pieceId: "p1",
      overlayId: "ov1",
      mode: "style",
    });
    expect(result.success).toBe(true);
    expect(result.data?.mode).toBe("style");
    expect(result.data?.overlayId).toBe("ov1");
    expect(setModeSpy).toHaveBeenCalledWith({
      pieceId: "p1",
      overlayId: "ov1",
      mode: "style",
    });
  });
});

describe("schemas", () => {
  it("highlightPropertySchema requires pieceId/overlayId/property, note optional ≤200", () => {
    expect(highlightPropertySchema.safeParse({ pieceId: "p", overlayId: "o", property: "content" }).success).toBe(true);
    expect(highlightPropertySchema.safeParse({ pieceId: "p", overlayId: "o" }).success).toBe(false);
    expect(
      highlightPropertySchema.safeParse({ pieceId: "p", overlayId: "o", property: "content", note: "x".repeat(201) }).success,
    ).toBe(false);
  });

  it("setComplexityModeSchema requires pieceId + overlayId + a valid group mode", () => {
    expect(
      setComplexityModeSchema.safeParse({ pieceId: "p", overlayId: "o", mode: "style" }).success,
    ).toBe(true);
    expect(
      setComplexityModeSchema.safeParse({ pieceId: "p", overlayId: "o", mode: "transform" }).success,
    ).toBe(true);
    expect(setComplexityModeSchema.safeParse({ pieceId: "p", mode: "style" }).success).toBe(false);
    expect(
      setComplexityModeSchema.safeParse({ pieceId: "p", overlayId: "o", mode: "advanced" }).success,
    ).toBe(false);
    expect(
      setComplexityModeSchema.safeParse({ pieceId: "p", overlayId: "o", mode: "bogus" }).success,
    ).toBe(false);
  });
});
