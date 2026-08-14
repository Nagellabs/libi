/** Reusable overlay-preset tools (SP2 Task 3.1).
 *
 * Capture an overlay's look (style/animation/transform/effects) as a named,
 * reusable preset, list bundled + user presets, apply a preset onto another
 * overlay, and delete a user preset. Pure async fns returning the loose
 * `ToolResult` shape (`{ success, data?, error? }`) — the `mcp/server.ts`
 * registration emits the `refresh_query composition` navigation event after a
 * successful `apply`, mirroring the other overlay tools. */

import { loadManifest, updateOverlayInManifest } from "@/lib/composition/persistence";
import {
  extractPresetFields,
  applyPresetPatch,
  isValidPresetSlug,
  type OverlayPreset,
} from "@/lib/overlays/presets";
import {
  listUserPresets,
  getUserPreset,
  saveUserPreset,
  deleteUserPreset,
  listPresets,
} from "@/lib/overlays/preset-store";
import { BUNDLED_OVERLAY_PRESETS } from "@/lib/overlays/caption-presets";
import { overlayLogger } from "@/lib/logger";
import type { ToolResult } from "./types";
import type {
  SaveOverlayPresetParams,
  ListOverlayPresetsParams,
  ApplyOverlayPresetParams,
  DeleteOverlayPresetParams,
} from "./schemas";

/** Lowercase, spaces/underscores → "-", strip non-`[a-z0-9-]`, collapse and
 *  trim repeats, cap at 49 chars (the slug regex ceiling). Falls back to
 *  "preset" when nothing survives. */
function slugifyPresetName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 49);
  return slug || "preset";
}

/**
 * save_overlay_preset — capture an overlay's reusable styling/animation/
 * transform/effects fields under a slugged, deduped id derived from `name`.
 */
export async function saveOverlayPreset(params: SaveOverlayPresetParams): Promise<ToolResult> {
  const { pieceId, overlayId, name, override } = params;
  const manifest = await loadManifest(pieceId);
  const overlay = (manifest.overlays ?? []).find((o) => o.id === overlayId) as
    | (Record<string, unknown> & { kind: OverlayPreset["kind"] })
    | undefined;
  if (!overlay) {
    overlayLogger.warn({ tag: "preset", pieceId, overlayId }, "preset.save miss — overlay not found");
    return { success: false, error: "overlay_not_found" };
  }

  const fields = extractPresetFields(overlay);

  const id = slugifyPresetName(name);

  // Bundled ids are reserved looks — they can never be overwritten.
  if (BUNDLED_OVERLAY_PRESETS.some((p) => p.id === id)) {
    return { success: false, error: "preset_name_reserved", data: { presetId: id } };
  }
  if (!isValidPresetSlug(id)) {
    return { success: false, error: "invalid_name" };
  }

  // Name-uniqueness: a user preset with this id (slug of the name) already exists.
  const existing = (await listUserPresets()).find((p) => p.id === id);
  if (existing && !override) {
    overlayLogger.info(
      { tag: "preset", event: "save_conflict", pieceId, overlayId, presetId: id },
      "preset.save name exists (override required)",
    );
    return { success: false, error: "preset_name_exists", data: { presetId: id, name } };
  }

  // On override, preserve the original createdAt (only updatedAt is bumped); a
  // brand-new save passes undefined so the store stamps both timestamps to now.
  await saveUserPreset({
    id,
    name,
    kind: overlay.kind,
    source: "user",
    fields,
    createdAt: existing?.createdAt,
  });
  overlayLogger.info(
    { tag: "preset", event: "save", pieceId, overlayId, presetId: id, kind: overlay.kind },
    "preset.save",
  );
  return { success: true, data: { presetId: id } };
}

/** list_overlay_presets — bundled + user presets, optionally filtered by kind. */
export async function listOverlayPresets(params: ListOverlayPresetsParams): Promise<ToolResult> {
  const presets = await listPresets(params.kind);
  return { success: true, data: { presets } };
}

/**
 * apply_overlay_preset — merge a preset's captured fields onto an overlay. The
 * preset kind must match the target overlay kind. The `refresh_query
 * composition` event is emitted by the server registration on success.
 */
export async function applyOverlayPreset(params: ApplyOverlayPresetParams): Promise<ToolResult> {
  const { pieceId, overlayId, presetId } = params;

  // Resolve user preset first (user shadows bundled by id), else bundled.
  const preset =
    (await getUserPreset(presetId)) ??
    BUNDLED_OVERLAY_PRESETS.find((p) => p.id === presetId) ??
    null;
  if (!preset) {
    overlayLogger.warn({ tag: "preset", pieceId, presetId }, "preset.apply miss — preset not found");
    return { success: false, error: "preset_not_found" };
  }

  const manifest = await loadManifest(pieceId);
  const overlay = (manifest.overlays ?? []).find((o) => o.id === overlayId) as
    | { kind: OverlayPreset["kind"] }
    | undefined;
  if (!overlay) {
    overlayLogger.warn({ tag: "preset", pieceId, overlayId }, "preset.apply miss — overlay not found");
    return { success: false, error: "overlay_not_found" };
  }

  if (preset.kind !== overlay.kind) {
    return {
      success: false,
      error: "kind_mismatch",
      data: { presetKind: preset.kind, overlayKind: overlay.kind },
    };
  }

  const ok = await updateOverlayInManifest(pieceId, overlayId, applyPresetPatch(preset) as never);
  if (!ok) {
    return { success: false, error: "overlay_not_found" };
  }
  overlayLogger.info(
    { tag: "preset", event: "apply", pieceId, overlayId, presetId },
    "preset.apply",
  );
  return { success: true };
}

/** delete_overlay_preset — remove a user-saved preset (bundled ids are a no-op). */
export async function deleteOverlayPreset(params: DeleteOverlayPresetParams): Promise<ToolResult> {
  await deleteUserPreset(params.presetId);
  overlayLogger.info(
    { tag: "preset", event: "delete", presetId: params.presetId },
    "preset.delete",
  );
  return { success: true };
}
