import { getCurrentPort } from "@/lib/libi-home";
import type { ToolResult } from "./types";
import type { RenderOverlayFramesParams } from "./schemas";

export async function renderOverlayFrames(
  params: RenderOverlayFramesParams,
): Promise<ToolResult> {
  let port: number;
  try {
    port = getCurrentPort();
  } catch {
    return {
      success: false,
      error: "libi_server_unavailable",
      data: {
        hint: "Start libi — the render-verify tool needs the running server to rasterize frames.",
      },
    };
  }

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/render/frames`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(300_000),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return {
        success: false,
        error: `render_overlay_frames failed (${resp.status}): ${txt.slice(0, 300)}`,
      };
    }

    const data = (await resp.json()) as {
      frames: {
        time: number;
        path: string;
        overflow: { touchesEdge: boolean; edges: string[] };
      }[];
      unresolvedFonts: string[];
      contactSheet?: string;
    };
    return {
      success: true,
      data: {
        frames: data.frames,
        unresolvedFonts: data.unresolvedFonts,
        ...(data.contactSheet ? { contactSheet: data.contactSheet } : {}),
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
