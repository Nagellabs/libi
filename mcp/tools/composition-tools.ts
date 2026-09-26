/** Composition-level tool implementations */

import { loadComposition } from "@/lib/composition/persistence";
import { toAgentOverlayRecord } from "@/lib/overlays/code-files";
import type { ToolContext, ToolResult } from "./types";

/**
 * get_composition — the piece's manifest as the agent sees it. Like
 * get_overlays, code-bearing overlays (code/three/tracked-code) carry an
 * absolute `codeFilePath` instead of their hydrated JS body: the agent reads
 * and edits that file directly, and the manifest stays small.
 */
export async function getComposition(ctx: ToolContext): Promise<ToolResult> {
  const { manifest } = await loadComposition(ctx.pieceId);
  const overlays = manifest.overlays
    ? await Promise.all(manifest.overlays.map((o) => toAgentOverlayRecord(ctx.pieceId, o)))
    : undefined;
  return {
    success: true,
    data: {
      manifest: {
        ...(manifest as unknown as Record<string, unknown>),
        ...(overlays ? { overlays } : {}),
      },
    },
  };
}
