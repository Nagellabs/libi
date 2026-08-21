import { eq } from "drizzle-orm";
import type { ToolResult } from "./types";
import { notify } from "@/mcp/notify";
import { getDb } from "@/lib/db/client";
import { files, pieces } from "@/lib/db/schema/sqlite";
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
 *
 * THE TARGET MUST BE PROVEN TO EXIST BEFORE WE CLAIM WE NAVIGATED. These four
 * used to return `{ navigated: true }` unconditionally, and the editor was
 * told to navigate BEFORE the tool ran at all — so pointing one at a deleted
 * piece produced a success the agent then relayed as fact. Observed
 * 2026-08-21: with the onboarding demo deleted, the agent called
 * `libi.show_piece` on the dead id, got `navigated: true`, and told the user
 * "It's back on screen — hit play" while the editor showed "No piece open".
 *
 * The agent cannot detect that on its own — nothing else in the turn
 * contradicts a success — so the check has to live here. Failures use the
 * `*_not_found` shape the rest of `mcp/tools/` uses, plus a `hint` naming the
 * tool that lists valid ids, so the agent can recover instead of dead-ending.
 *
 * The matching half of this fix is in `mcp/server.ts`: each registration now
 * calls the tool FIRST and fires `notify.navigate` only when it succeeds.
 * Leaving the notify ahead of the check would still yank the editor toward a
 * piece that isn't there, and merely report the error afterwards.
 */

/** `null` when the piece exists; the failure result to return when it does not. */
function pieceMissing(pieceId: string): ToolResult | null {
  const db = getDb();
  const [piece] = db.select().from(pieces).where(eq(pieces.id, pieceId)).limit(1).all();
  if (piece) return null;
  return {
    success: false,
    error: "piece_not_found",
    data: {
      hint:
        `No piece "${pieceId}" — it may have been deleted. Do not tell the ` +
        `user it is on screen. Use libi.list_pieces to see what exists.`,
    },
  };
}

export async function showPiece(params: { pieceId: string }): Promise<ToolResult> {
  const missing = pieceMissing(params.pieceId);
  if (missing) return missing;
  return { success: true, data: { navigated: true, pieceId: params.pieceId } };
}

export async function showAsset(params: {
  pieceId: string;
  fileId: string;
}): Promise<ToolResult> {
  const missing = pieceMissing(params.pieceId);
  if (missing) return missing;

  const db = getDb();
  const [file] = db.select().from(files).where(eq(files.id, params.fileId)).limit(1).all();
  if (!file) {
    return {
      success: false,
      error: "file_not_found",
      data: {
        hint:
          `No file "${params.fileId}". Use libi.list_files to see what this ` +
          `piece has.`,
      },
    };
  }
  // `files.pieceId` is nullable, and NULL means a global file that every piece
  // can show. A file owned by a DIFFERENT piece is the same silent lie as a
  // deleted one: the Assets tab has nothing to select, so the navigate is a
  // no-op the agent would report as done.
  if (file.pieceId !== null && file.pieceId !== params.pieceId) {
    return {
      success: false,
      error: "file_not_in_piece",
      data: {
        hint:
          `File "${params.fileId}" belongs to piece "${file.pieceId}", not ` +
          `"${params.pieceId}" — the Assets tab would have nothing to show. ` +
          `Navigate to the owning piece, or pass a file from this one.`,
        ownerPieceId: file.pieceId,
      },
    };
  }

  return {
    success: true,
    data: { navigated: true, pieceId: params.pieceId, fileId: params.fileId },
  };
}

export async function showPreview(params: {
  pieceId: string;
}): Promise<ToolResult> {
  const missing = pieceMissing(params.pieceId);
  if (missing) return missing;
  return { success: true, data: { navigated: true, pieceId: params.pieceId } };
}

export async function showStoryboard(params: {
  pieceId: string;
}): Promise<ToolResult> {
  const missing = pieceMissing(params.pieceId);
  if (missing) return missing;
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
