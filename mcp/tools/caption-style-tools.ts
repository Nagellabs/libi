/** Caption-style tools — let the agent mint reusable static caption LOOKS.
 *
 * A caption STYLE is the static-look subset of a text overlay (color + optional
 * stroke / shadow / background / font). The user picks one from the Style tab.
 * The agent can create new ones from a user's example (e.g. "make me a punchy
 * pink one with a thick black outline") via `create_caption_style`; they
 * persist and show in the Style list for later reuse.
 *
 * Persistence reuses the overlay-preset store: a user caption style is stored as
 * a `kind: "text"` user preset whose `fields` hold only the look keys. The
 * server-side `listCaptionStyles()` already merges those into the style list, so
 * a created style appears in the picker automatically. Pure async fns returning
 * the loose `ToolResult` shape; `mcp/server.ts` emits a `caption-styles`
 * refresh_query after a successful create/delete. */

import { isValidPresetSlug } from "@/lib/overlays/presets";
import {
  listUserPresets,
  saveUserPreset,
  deleteUserPreset,
} from "@/lib/overlays/preset-store";
import { BUNDLED_OVERLAY_PRESETS } from "@/lib/overlays/caption-presets";
import { CAPTION_STYLES } from "@/lib/captions/styles";
import { listCaptionStyles } from "@/lib/captions/styles.server";
import { overlayLogger } from "@/lib/logger";
import type { ToolResult } from "./types";
import type {
  CreateCaptionStyleParams,
  DeleteCaptionStyleParams,
} from "./schemas";

/** Lowercase, spaces/underscores → "-", strip non-`[a-z0-9-]`, collapse repeats,
 *  cap at 49 chars (the slug ceiling). Falls back to "style" when nothing
 *  survives. */
function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 49);
  return slug || "style";
}

/** A bundled style id OR a bundled preset id is reserved — user styles can never
 *  overwrite the curated looks. */
function isReservedId(id: string): boolean {
  return (
    CAPTION_STYLES.some((s) => s.id === id) ||
    BUNDLED_OVERLAY_PRESETS.some((p) => p.id === id)
  );
}

/**
 * create_caption_style — persist a new user caption style from explicit look
 * fields (no overlay needed). Slug derived from `name`; reserved-id and
 * name-uniqueness guarded (override to replace).
 */
export async function createCaptionStyle(
  params: CreateCaptionStyleParams,
): Promise<ToolResult> {
  const { name, override, ...look } = params;
  const id = slugifyName(name);

  if (isReservedId(id)) {
    return { success: false, error: "style_name_reserved", data: { styleId: id } };
  }
  if (!isValidPresetSlug(id)) {
    return { success: false, error: "invalid_name" };
  }

  // Only the look keys (drop undefined so the stored fields stay clean).
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(look)) {
    if (v !== undefined) fields[k] = v;
  }

  const existing = (await listUserPresets()).find((p) => p.id === id);
  if (existing && !override) {
    overlayLogger.info(
      { tag: "caption-style", event: "create_conflict", styleId: id },
      "caption-style.create name exists (override required)",
    );
    return { success: false, error: "style_name_exists", data: { styleId: id, name } };
  }

  await saveUserPreset({
    id,
    name,
    kind: "text",
    source: "user",
    fields,
    createdAt: existing?.createdAt,
  });
  overlayLogger.info(
    { tag: "caption-style", event: "create", styleId: id },
    "caption-style.create",
  );
  return { success: true, data: { styleId: id } };
}

/** list_caption_styles — bundled + user caption styles (the Style-tab list). */
export async function listCaptionStylesTool(): Promise<ToolResult> {
  const styles = await listCaptionStyles();
  return { success: true, data: { styles } };
}

/** delete_caption_style — remove a user caption style (bundled ids are a no-op). */
export async function deleteCaptionStyle(
  params: DeleteCaptionStyleParams,
): Promise<ToolResult> {
  if (isReservedId(params.styleId)) {
    return { success: false, error: "style_name_reserved", data: { styleId: params.styleId } };
  }
  await deleteUserPreset(params.styleId);
  overlayLogger.info(
    { tag: "caption-style", event: "delete", styleId: params.styleId },
    "caption-style.delete",
  );
  return { success: true };
}
