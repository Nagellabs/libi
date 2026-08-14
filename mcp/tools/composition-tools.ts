/** Composition-level tool implementations */

import { loadComposition } from "@/lib/composition/persistence";
import type { ToolContext, ToolResult } from "./types";

export async function getComposition(ctx: ToolContext): Promise<ToolResult> {
  const comp = await loadComposition(ctx.pieceId);
  return {
    success: true,
    data: {
      manifest: comp.manifest as unknown as Record<string, unknown>,
      scenes: comp.scenes as unknown as Record<string, unknown>[],
    },
  };
}
