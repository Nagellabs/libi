/** Scene CRUD tool implementations */

import { validateDrawFunction } from "@/lib/ai/scene-validator";
import {
  saveSceneAndUpdateManifest,
  loadScene,
  updateSceneInManifest,
  removeSceneAndUpdateManifest,
  updateSceneOrder,
} from "@/lib/composition/persistence";
import type { ToolContext, ToolResult } from "./types";
import type {
  CreateSceneParams,
  UpdateSceneParams,
  DeleteSceneParams,
  ReorderScenesParams,
  LoadSceneParams,
} from "./schemas";

function randomId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export async function createScene(
  ctx: ToolContext,
  params: CreateSceneParams,
): Promise<ToolResult> {
  const { name, duration, drawFunction } = params;

  const validation = validateDrawFunction(drawFunction);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const sceneId = `scene_${randomId()}`;

  await saveSceneAndUpdateManifest(ctx.pieceId, { id: sceneId, type: "canvas", name, duration, drawFunction });

  return {
    success: true,
    data: { sceneId, name, duration, drawFunction },
  };
}

export async function updateScene(
  ctx: ToolContext,
  params: UpdateSceneParams,
): Promise<ToolResult> {
  const { sceneId, name, duration, drawFunction } = params;

  if (drawFunction !== undefined) {
    const validation = validateDrawFunction(drawFunction);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
  }

  const existing = await loadScene(ctx.pieceId, sceneId);
  if (existing) {
    const updated = {
      ...existing,
      ...(name !== undefined && { name }),
      ...(duration !== undefined && { duration }),
      ...(drawFunction !== undefined && { drawFunction }),
    };
    await updateSceneInManifest(ctx.pieceId, updated);
  }

  return {
    success: true,
    data: {
      sceneId,
      ...(name !== undefined && { name }),
      ...(duration !== undefined && { duration }),
      ...(drawFunction !== undefined && { drawFunction }),
    },
  };
}

export async function deleteScene(
  ctx: ToolContext,
  params: DeleteSceneParams,
): Promise<ToolResult> {
  const { sceneId } = params;

  const { removedClips } = await removeSceneAndUpdateManifest(ctx.pieceId, sceneId);

  return {
    success: true,
    data: { sceneId, removedClips },
  };
}

export async function reorderScenes(
  ctx: ToolContext,
  params: ReorderScenesParams,
): Promise<ToolResult> {
  const { sceneIds } = params;

  await updateSceneOrder(ctx.pieceId, sceneIds);

  return {
    success: true,
    data: { sceneIds, message: `Scenes reordered: ${sceneIds.join(", ")}` },
  };
}

export async function loadSceneData(
  ctx: ToolContext,
  params: LoadSceneParams,
): Promise<ToolResult> {
  const { sceneId } = params;

  const scene = await loadScene(ctx.pieceId, sceneId);
  if (!scene) {
    return { success: false, error: `Scene ${sceneId} not found` };
  }

  return {
    success: true,
    data: { scene },
  };
}
