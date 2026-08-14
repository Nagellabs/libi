import type { ToolResult } from "./types";
import { notify } from "@/mcp/notify";
import { loadManifest } from "@/lib/composition/persistence";
import {
  findField,
  isKnownFieldKey,
  targetGroupForField,
  fieldKeysForKind,
  type InspectorOverlayKind,
} from "@/lib/overlays/inspector-fields";

/**
 * Navigation tools emit SSE events to control the editor UI.
 * The actual event emission is handled by the MCP server registration
 * which has access to the navigation event emitter.
 * These functions just validate and return success.
 */

export async function showPiece(params: { pieceId: string }): Promise<ToolResult> {
  return { success: true, data: { navigated: true, pieceId: params.pieceId } };
}

export async function showAsset(params: {
  pieceId: string;
  fileId: string;
}): Promise<ToolResult> {
  return {
    success: true,
    data: { navigated: true, pieceId: params.pieceId, fileId: params.fileId },
  };
}

export async function showPreview(params: {
  pieceId: string;
}): Promise<ToolResult> {
  return { success: true, data: { navigated: true, pieceId: params.pieceId } };
}

export async function showStoryboard(params: {
  pieceId: string;
}): Promise<ToolResult> {
  return { success: true, data: { navigated: true, pieceId: params.pieceId } };
}

/** Overlay kinds whose field keys are listed in the unknown-property hint. */
const HINT_KINDS: InspectorOverlayKind[] = [
  "text",
  "image",
  "video",
  "code",
  "three",
  "tracked",
];

/**
 * Guided edit: flash an inspector field for an overlay. Validates `property`
 * against the inspector-field registry; an unknown key returns a structured
 * error listing the valid keys (grouped by overlay kind) so the agent can
 * correct itself. On success it fires the `highlight` notify and reports the
 * mode the inspector will auto-bump to.
 */
export async function highlightProperty(params: {
  pieceId: string;
  overlayId: string;
  property: string;
  note?: string;
}): Promise<ToolResult> {
  // 1) The key must exist in the registry for SOME kind — a completely
  // unknown key gets the full grouped hint (unchanged behavior).
  if (!isKnownFieldKey(params.property)) {
    const validKeysByKind = Object.fromEntries(
      HINT_KINDS.map((kind) => [kind, fieldKeysForKind(kind)]),
    );
    return {
      success: false,
      error: "unknown_property",
      data: {
        hint: `Unknown inspector property "${params.property}". Pass one of the known field keys (see validKeys, grouped by overlay kind).`,
        validKeys: Array.from(
          new Set(HINT_KINDS.flatMap((kind) => fieldKeysForKind(kind))),
        ),
        validKeysByKind,
      },
    };
  }

  // 2) Resolve the TARGET overlay's kind — applicability is per (key, kind)
  // (e.g. "transformPosX" exists for text but NOT tracked). Without this an
  // inapplicable key "succeeds" server-side and silently no-ops client-side
  // (no field to flash).
  let kind: InspectorOverlayKind;
  try {
    const manifest = await loadManifest(params.pieceId);
    const ov = (manifest.overlays ?? []).find((o) => o.id === params.overlayId);
    if (!ov) {
      return {
        success: false,
        error: "overlay_not_found",
        data: {
          hint: `No overlay "${params.overlayId}" in piece "${params.pieceId}". Use libi.get_overlays to list overlay ids.`,
        },
      };
    }
    kind = ov.kind as InspectorOverlayKind;
  } catch (err) {
    return {
      success: false,
      error: "piece_not_found",
      data: {
        hint: `Could not load piece "${params.pieceId}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    };
  }

  if (!findField(params.property, kind)) {
    return {
      success: false,
      error: "property_not_applicable",
      data: {
        hint:
          `"${params.property}" is not an inspector field on a ${kind} overlay — ` +
          `highlighting it would silently no-op. Pass one of validKeys (the ${kind} keys).`,
        kind,
        validKeys: fieldKeysForKind(kind),
      },
    };
  }

  notify.highlight({
    pieceId: params.pieceId,
    overlayId: params.overlayId,
    property: params.property,
    note: params.note,
  });

  return {
    success: true,
    data: {
      highlighted: true,
      kind,
      // Kind-aware: the same key can sit on a DIFFERENT tab per kind — the
      // old kind-less lookup reported the first def's group across any kind.
      bumpedModeTo: targetGroupForField(params.property, kind),
    },
  };
}

/** Switch a specific overlay's inspector tab/group (transform / style / text / 3d). */
export async function setComplexityMode(params: {
  pieceId: string;
  overlayId: string;
  mode: "transform" | "style" | "text" | "3d" | "anchors";
}): Promise<ToolResult> {
  notify.setComplexityMode({
    pieceId: params.pieceId,
    overlayId: params.overlayId,
    mode: params.mode,
  });
  return { success: true, data: { overlayId: params.overlayId, mode: params.mode } };
}
