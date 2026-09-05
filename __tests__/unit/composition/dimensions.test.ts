import { describe, it, expect, vi, beforeEach } from "vitest";

const loadManifest = vi.fn();
const saveManifest = vi.fn(async () => {});
vi.mock("@/lib/composition/persistence", () => ({
  loadManifest: (id: string) => loadManifest(id),
  saveManifest: (id: string, m: unknown) => saveManifest(id, m),
}));

const emit = vi.fn();
vi.mock("@/lib/navigation-events", () => ({ navigationEmitter: { emit: (...a: unknown[]) => emit(...a) } }));

import { setCompositionDimensions } from "@/lib/composition/dimensions";

const manifest = (overlays: unknown[] = []) => ({
  width: 1920,
  height: 1080,
  fps: 30,
  overlays,
  audioClips: [],
});

beforeEach(() => {
  loadManifest.mockReset();
  saveManifest.mockClear();
  emit.mockClear();
});

describe("setCompositionDimensions", () => {
  it("writes the new dimensions and reports the previous ones", async () => {
    loadManifest.mockResolvedValue(manifest());
    const r = await setCompositionDimensions("p1", 1080, 1920);

    expect(r).toMatchObject({
      width: 1080, height: 1920, previousWidth: 1920, previousHeight: 1080,
    });
    expect(saveManifest).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ width: 1080, height: 1920 }),
    );
  });

  it("invalidates the composition query so the canvas re-renders", async () => {
    // Data flows one way: write -> SSE -> React Query invalidate -> render.
    // Without this the user resizes and sees nothing change.
    loadManifest.mockResolvedValue(manifest());
    await setCompositionDimensions("p1", 1080, 1920);
    expect(emit).toHaveBeenCalledWith("refresh_query", {
      queryKey: "composition",
      pieceId: "p1",
    });
  });

  it("warns about each overlay left outside the new bounds", async () => {
    loadManifest.mockResolvedValue(
      manifest([
        { id: "o1", kind: "video", rect: { x: 0, y: 0, width: 1920, height: 1080 } },
        { id: "o2", kind: "text", rect: { x: 10, y: 10, width: 100, height: 50 } },
      ]),
    );
    const r = await setCompositionDimensions("p1", 1080, 1920);

    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("o1");
    // o2 fits inside 1080x1920 and must not be reported — a warning list that
    // includes fine overlays trains the agent to ignore it.
    expect(r.warnings.join(" ")).not.toContain("o2");
  });

  it("warns about a negative-origin overlay", async () => {
    loadManifest.mockResolvedValue(
      manifest([{ id: "o3", kind: "image", rect: { x: -5, y: 0, width: 10, height: 10 } }]),
    );
    const r = await setCompositionDimensions("p1", 1080, 1920);
    expect(r.warnings[0]).toContain("o3");
  });

  it("warns about a rect-less overlay instead of dropping it silently", async () => {
    loadManifest.mockResolvedValue(
      manifest([{ id: "o4", kind: "text" }]),
    );
    const r = await setCompositionDimensions("p1", 1080, 1920);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("o4");
  });

  it("distinguishes a rect-less warning from an out-of-bounds warning", async () => {
    loadManifest.mockResolvedValue(
      manifest([
        { id: "o5", kind: "text" },
        { id: "o6", kind: "image", rect: { x: -5, y: 0, width: 10, height: 10 } },
      ]),
    );
    const r = await setCompositionDimensions("p1", 1080, 1920);
    expect(r.warnings).toHaveLength(2);

    const rectless = r.warnings.find((w) => w.includes("o5"));
    const outOfBounds = r.warnings.find((w) => w.includes("o6"));
    expect(rectless).toBeDefined();
    expect(outOfBounds).toBeDefined();
    expect(rectless).not.toBe(outOfBounds);
    expect(rectless).not.toContain("extends beyond");
    expect(outOfBounds).toContain("extends beyond");
  });

  it("uses the × (U+00D7) character in the out-of-bounds warning, not ASCII x", async () => {
    loadManifest.mockResolvedValue(
      manifest([{ id: "o3", kind: "image", rect: { x: -5, y: 0, width: 10, height: 10 } }]),
    );
    const r = await setCompositionDimensions("p1", 1080, 1920);
    expect(r.warnings[0]).toContain("×");
  });

  it("rejects non-positive dimensions without writing", async () => {
    loadManifest.mockResolvedValue(manifest());
    await expect(setCompositionDimensions("p1", 0, 1920)).rejects.toThrow(/positive/);
    await expect(setCompositionDimensions("p1", 1080, -1)).rejects.toThrow(/positive/);
    expect(saveManifest).not.toHaveBeenCalled();
  });
});
