import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "@/mcp/tools/types";

// Mock persistence module
vi.mock("@/lib/composition/persistence", () => ({
  saveSceneAndUpdateManifest: vi.fn(),
  loadScene: vi.fn(),
  saveScene: vi.fn(),
  updateSceneInManifest: vi.fn(),
  removeSceneAndUpdateManifest: vi.fn(),
  updateSceneOrder: vi.fn(),
}));

// Mock scene validator
vi.mock("@/lib/ai/scene-validator", () => ({
  validateDrawFunction: vi.fn(),
}));

import {
  createScene,
  updateScene,
  deleteScene,
  reorderScenes,
  loadSceneData,
} from "@/mcp/tools/scene-tools";
import {
  saveSceneAndUpdateManifest,
  loadScene,
  saveScene,
  updateSceneInManifest,
  removeSceneAndUpdateManifest,
  updateSceneOrder,
} from "@/lib/composition/persistence";
import { validateDrawFunction } from "@/lib/ai/scene-validator";

const mockSaveSceneAndUpdateManifest = vi.mocked(saveSceneAndUpdateManifest);
const mockLoadScene = vi.mocked(loadScene);
const mockSaveScene = vi.mocked(saveScene);
const mockUpdateSceneInManifest = vi.mocked(updateSceneInManifest);
const mockRemoveSceneAndUpdateManifest = vi.mocked(removeSceneAndUpdateManifest);
const mockUpdateSceneOrder = vi.mocked(updateSceneOrder);
const mockValidateDrawFunction = vi.mocked(validateDrawFunction);

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { pieceId: "piece-123", ...overrides };
}

describe("createScene", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveSceneAndUpdateManifest.mockResolvedValue(undefined);
  });

  it("creates a scene with valid drawFunction", async () => {
    mockValidateDrawFunction.mockReturnValue({ valid: true });

    const ctx = makeCtx();
    const params = {
      pieceId: "piece-123",
      name: "Intro",
      duration: 3,
      drawFunction: "ctx.fillRect(0, 0, 100, 100);",
    };

    const result = await createScene(ctx, params);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: "Intro",
      duration: 3,
      drawFunction: "ctx.fillRect(0, 0, 100, 100);",
    });
    expect(result.data?.sceneId).toMatch(/^scene_/);
    expect(mockSaveSceneAndUpdateManifest).toHaveBeenCalledOnce();
  });

  it("returns error for invalid drawFunction", async () => {
    mockValidateDrawFunction.mockReturnValue({
      valid: false,
      error: "Draw function contains disallowed pattern: fetch() calls",
    });

    const ctx = makeCtx();
    const params = {
      pieceId: "piece-123",
      name: "Bad Scene",
      duration: 2,
      drawFunction: "fetch('/api')",
    };

    const result = await createScene(ctx, params);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Draw function contains disallowed pattern: fetch() calls");
    expect(mockSaveSceneAndUpdateManifest).not.toHaveBeenCalled();
  });
});

describe("updateScene", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSceneInManifest.mockResolvedValue(true);
  });

  it("updates an existing scene", async () => {
    mockValidateDrawFunction.mockReturnValue({ valid: true });
    mockLoadScene.mockResolvedValue({
      id: "scene-abc",
      type: "canvas",
      name: "Old Name",
      duration: 2,
      drawFunction: "// old",
    });

    const ctx = makeCtx();
    const params = {
      pieceId: "piece-123",
      sceneId: "scene-abc",
      name: "New Name",
      duration: 5,
      drawFunction: "// new code",
    };

    const result = await updateScene(ctx, params);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      sceneId: "scene-abc",
      name: "New Name",
      duration: 5,
      drawFunction: "// new code",
    });
    expect(mockUpdateSceneInManifest).toHaveBeenCalledWith(
      "piece-123",
      expect.objectContaining({ id: "scene-abc", name: "New Name", duration: 5 }),
    );
  });

  it("succeeds even when scene does not exist (no-op save)", async () => {
    mockLoadScene.mockResolvedValue(null);

    const ctx = makeCtx();
    const params = { pieceId: "piece-123", sceneId: "missing-scene", name: "Whatever" };

    const result = await updateScene(ctx, params);

    expect(result.success).toBe(true);
    expect(mockUpdateSceneInManifest).not.toHaveBeenCalled();
  });

  it("returns error when drawFunction is invalid", async () => {
    mockValidateDrawFunction.mockReturnValue({
      valid: false,
      error: "Draw function contains disallowed pattern: eval() calls",
    });

    const ctx = makeCtx();
    const params = { pieceId: "piece-123", sceneId: "scene-abc", drawFunction: "eval('bad')" };

    const result = await updateScene(ctx, params);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Draw function contains disallowed pattern: eval() calls");
    expect(mockLoadScene).not.toHaveBeenCalled();
  });

  it("skips drawFunction validation when drawFunction is not provided", async () => {
    mockLoadScene.mockResolvedValue({
      id: "scene-abc",
      type: "canvas",
      name: "Old Name",
      duration: 2,
      drawFunction: "// original",
    });

    const ctx = makeCtx();
    const params = { pieceId: "piece-123", sceneId: "scene-abc", name: "Renamed" };

    const result = await updateScene(ctx, params);

    expect(result.success).toBe(true);
    expect(mockValidateDrawFunction).not.toHaveBeenCalled();
  });
});

describe("deleteScene", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRemoveSceneAndUpdateManifest.mockResolvedValue({ removedClips: [] });
  });

  it("deletes a scene", async () => {
    const ctx = makeCtx();
    const params = { pieceId: "piece-123", sceneId: "scene-xyz" };

    const result = await deleteScene(ctx, params);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ sceneId: "scene-xyz" });
    expect(mockRemoveSceneAndUpdateManifest).toHaveBeenCalledWith("piece-123", "scene-xyz");
  });
});

describe("reorderScenes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSceneOrder.mockResolvedValue(undefined);
  });

  it("reorders scenes", async () => {
    const ctx = makeCtx();
    const params = { pieceId: "piece-123", sceneIds: ["scene-b", "scene-a", "scene-c"] };

    const result = await reorderScenes(ctx, params);

    expect(result.success).toBe(true);
    expect(result.data?.sceneIds).toEqual(["scene-b", "scene-a", "scene-c"]);
    expect(mockUpdateSceneOrder).toHaveBeenCalledWith("piece-123", ["scene-b", "scene-a", "scene-c"]);
  });
});

describe("loadSceneData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the scene when found", async () => {
    const sceneData = {
      id: "scene-abc",
      type: "canvas" as const,
      name: "My Scene",
      duration: 4,
      drawFunction: "// draw",
    };
    mockLoadScene.mockResolvedValue(sceneData);

    const ctx = makeCtx();
    const result = await loadSceneData(ctx, { pieceId: "piece-123", sceneId: "scene-abc" });

    expect(result.success).toBe(true);
    expect(result.data?.scene).toEqual(sceneData);
  });

  it("returns error when scene is not found", async () => {
    mockLoadScene.mockResolvedValue(null);

    const ctx = makeCtx();
    const result = await loadSceneData(ctx, { pieceId: "piece-123", sceneId: "ghost-scene" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Scene ghost-scene not found");
  });
});
