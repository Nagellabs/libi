import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "@/mcp/tools/types";

vi.mock("@/lib/composition/persistence", () => ({
  loadComposition: vi.fn(),
}));

import { getComposition } from "@/mcp/tools/composition-tools";
import { loadComposition } from "@/lib/composition/persistence";

const mockLoadComposition = vi.mocked(loadComposition);

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { pieceId: "piece-456", ...overrides };
}

describe("getComposition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns manifest and scenes when composition has scenes", async () => {
    const manifest = { sceneOrder: ["scene-1", "scene-2"], width: 1920, height: 1080, fps: 30 };
    const scenes = [
      { id: "scene-1", type: "canvas" as const, name: "Intro", duration: 3, drawFunction: "// intro" },
      { id: "scene-2", type: "canvas" as const, name: "Outro", duration: 2, drawFunction: "// outro" },
    ];
    mockLoadComposition.mockResolvedValue({ manifest, scenes });

    const ctx = makeCtx();
    const result = await getComposition(ctx);

    expect(result.success).toBe(true);
    expect(result.data?.manifest).toEqual(manifest);
    expect(result.data?.scenes).toEqual(scenes);
    expect(mockLoadComposition).toHaveBeenCalledWith("piece-456");
  });

  it("returns empty scenes array when composition has no scenes", async () => {
    const manifest = { sceneOrder: [], width: 1920, height: 1080, fps: 30 };
    mockLoadComposition.mockResolvedValue({ manifest, scenes: [] });

    const ctx = makeCtx();
    const result = await getComposition(ctx);

    expect(result.success).toBe(true);
    expect(result.data?.scenes).toEqual([]);
    expect((result.data?.manifest as { sceneOrder: string[] }).sceneOrder).toEqual([]);
  });
});
