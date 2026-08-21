/**
 * E2E-only tool dispatch. Calls the libi tool function directly, bypassing
 * the MCP stdio transport. Used by Playwright specs to drive deterministic
 * setup without touching the agent chat.
 *
 * DISABLED by default. Enable with `LIBI_ENABLE_TEST_ROUTES=1` (RC-B). The
 * skill-eval harness / e2e runner set this on the libi process they spawn.
 *
 * Mirrors the MCP server's behavior of firing `notify.refreshQuery` on success
 * so the editor UI stays in sync.
 */
import { NextResponse } from "next/server";
import { trimVideo } from "@/mcp/tools/ffmpeg-tools";
import {
  addOverlay,
  updateOverlay,
  getOverlays,
  removeOverlayTool,
  reorderOverlays,
} from "@/mcp/tools/overlay-tools";
import { notify } from "@/mcp/notify";
import { testRoutesEnabled } from "@/lib/security/test-routes";
import { serverLogger as logger } from "@/lib/logger";

interface DispatchEntry {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  refresh: (args: Record<string, unknown>, result: unknown) =>
    | { queryKey: string; pieceId?: string }
    | null;
}

const DISPATCH: Record<string, DispatchEntry> = {
  "libi.trim_video": {
    handler: async (args) =>
      trimVideo(args as unknown as Parameters<typeof trimVideo>[0]),
    refresh: (args, result) => {
      const r = result as { success?: boolean };
      if (!r.success) return null;
      return {
        queryKey: "piece",
        pieceId: (args as { pieceId?: string }).pieceId,
      };
    },
  },
  "libi.add_overlay": {
    handler: async (args) =>
      addOverlay(args as unknown as Parameters<typeof addOverlay>[0]),
    refresh: (args, result) => {
      const r = result as { success?: boolean };
      if (!r.success) return null;
      const pieceId = (args as { pieceId?: string }).pieceId;
      return pieceId ? { queryKey: "composition", pieceId } : null;
    },
  },
  "libi.update_overlay": {
    handler: async (args) =>
      updateOverlay(args as unknown as Parameters<typeof updateOverlay>[0]),
    refresh: (args, result) => {
      const r = result as { success?: boolean };
      if (!r.success) return null;
      const pieceId = (args as { pieceId?: string }).pieceId;
      return pieceId ? { queryKey: "composition", pieceId } : null;
    },
  },
  "libi.get_overlays": {
    handler: async (args) =>
      getOverlays(args as unknown as Parameters<typeof getOverlays>[0]),
    refresh: () => null,
  },
  "libi.remove_overlay": {
    handler: async (args) =>
      removeOverlayTool(args as unknown as Parameters<typeof removeOverlayTool>[0]),
    refresh: (args, result) => {
      const r = result as { success?: boolean };
      if (!r.success) return null;
      const pieceId = (args as { pieceId?: string }).pieceId;
      return pieceId ? { queryKey: "composition", pieceId } : null;
    },
  },
  "libi.reorder_overlays": {
    handler: async (args) =>
      reorderOverlays(args as unknown as Parameters<typeof reorderOverlays>[0]),
    refresh: (args, result) => {
      const r = result as { success?: boolean };
      if (!r.success) return null;
      const pieceId = (args as { pieceId?: string }).pieceId;
      return pieceId ? { queryKey: "composition", pieceId } : null;
    },
  },
};

function enabled(): boolean {
  return testRoutesEnabled();
}

export async function POST(req: Request): Promise<Response> {
  if (!enabled()) {
    return NextResponse.json(
      { error: "E2E tool dispatch is disabled in this environment" },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = body as { tool?: string; args?: Record<string, unknown> };
  const tool = parsed.tool;
  const args = parsed.args ?? {};
  if (!tool || typeof tool !== "string") {
    return NextResponse.json({ error: "Missing tool name" }, { status: 400 });
  }

  const entry = DISPATCH[tool];
  if (!entry) {
    return NextResponse.json(
      { error: `Unknown tool: ${tool}` },
      { status: 404 },
    );
  }

  try {
    const result = await entry.handler(args);
    const refresh = entry.refresh(args, result);
    if (refresh) {
      try {
        notify.refreshQuery(refresh);
      } catch {
        /* fire-and-forget; don't fail the call */
      }
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ tool, err: message }, "e2e.run-tool failed");
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
