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
 *
 * Arguments are validated first, exactly as libi's MCP endpoint validates an
 * agent's (`lib/e2e/run-tool-input.ts`): a call an agent would have had refused
 * is refused here with the same `CallToolResult` text (HTTP 400, plus
 * `success: false` / `error` for the specs' own checks), and the tool receives
 * the parsed arguments. A seed no agent could have made fails where it is made.
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
import {
  createTemplateFromPiece,
  applyTemplate,
  deleteTemplateTool,
  listTemplatesTool,
} from "@/mcp/tools/template-tools";
import { publishTemplate } from "@/mcp/tools/template-cloud-tools";
import { uploadFont } from "@/mcp/tools/font-tools";
import { getPieceStateTool } from "@/mcp/tools/snapshot-tools";
import { addEffectTool, removeEffectTool } from "@/mcp/tools/effect-package-tools";
import { applyLayerEffect } from "@/mcp/tools/effect-tools";
import { notify } from "@/mcp/notify";
import { testRoutesEnabled } from "@/lib/security/test-routes";
import { serverLogger as logger } from "@/lib/logger";
import { validateToolInput, type RunToolName } from "@/lib/e2e/run-tool-input";

interface DispatchEntry {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  refresh: (args: Record<string, unknown>, result: unknown) =>
    | { queryKey: string; pieceId?: string }
    | null;
}

// Keyed by RunToolName: a tool dispatched here must have its MCP input schema
// in lib/e2e/run-tool-input.ts, and vice versa.
const DISPATCH: Record<RunToolName, DispatchEntry> = {
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
  "libi.upload_font": {
    handler: async (args) =>
      uploadFont(args as unknown as Parameters<typeof uploadFont>[0]),
    // Mirrors mcp/server.ts's `libi.upload_font`: a piece-scoped upload
    // invalidates that PIECE (the font lands in its file list), a global one
    // invalidates the shared `files` list. Not interchangeable — `files` keyed
    // by a pieceId is a query key the app never fires.
    refresh: (args, result) => {
      const r = result as { success?: boolean };
      if (!r.success) return null;
      const pieceId = (args as { pieceId?: string }).pieceId;
      return pieceId ? { queryKey: "piece", pieceId } : { queryKey: "files" };
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
  // Read-only: the piece state the agent reads, including its
  // `renderDiagnostics` as the agent receives them (framed as untrusted).
  // e2e/overlay-sandbox.spec.ts asserts a hostile body's diagnostics here.
  "libi.get_piece_state": {
    handler: async (args) =>
      getPieceStateTool(args as unknown as Parameters<typeof getPieceStateTool>[0]),
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
  // The custom-effect tools e2e/overlay-sandbox.spec.ts drives: a custom
  // effect body runs only in the effect sampler's sandbox. Each `refresh`
  // mirrors the agent path: `mcp/server.ts` sends `effects-custom` (which
  // re-fetches `/api/effects`, the page's source of custom effect bodies)
  // after add/remove, while `applyLayerEffect` sends its own `composition`
  // refresh from inside the tool (mcp/tools/effect-tools.ts), so the route
  // adds none — the spec's repaint then rides on the tool's own notify.
  "libi.add_effect": {
    handler: async (args) =>
      addEffectTool(args as unknown as Parameters<typeof addEffectTool>[0]),
    refresh: (_args, result) =>
      (result as { success?: boolean }).success ? { queryKey: "effects-custom" } : null,
  },
  "libi.remove_effect": {
    handler: async (args) =>
      removeEffectTool(args as unknown as Parameters<typeof removeEffectTool>[0]),
    refresh: (_args, result) =>
      (result as { success?: boolean }).success ? { queryKey: "effects-custom" } : null,
  },
  "libi.apply_layer_effect": {
    handler: async (args) =>
      applyLayerEffect(args as unknown as Parameters<typeof applyLayerEffect>[0]),
    refresh: () => null,
  },
  // The template tools the templates e2e specs drive. Each `refresh`
  // mirrors what `mcp/server.ts` emits for the same tool — the point of this
  // route is that a spec walks the agent's path, so a query the agent's call
  // would have invalidated must be invalidated here too.
  "libi.create_template_from_piece": {
    handler: async (args) =>
      createTemplateFromPiece(args as unknown as Parameters<typeof createTemplateFromPiece>[0]),
    refresh: (_args, result) =>
      (result as { success?: boolean }).success ? { queryKey: "templates" } : null,
  },
  "libi.apply_template": {
    handler: async (args) =>
      applyTemplate(args as unknown as Parameters<typeof applyTemplate>[0]),
    refresh: (_args, result) => {
      const r = result as { success?: boolean; data?: { pieceId?: string; partial?: boolean } };
      const pieceId = r.data?.pieceId;
      if (!r.success) {
        // A PARTIAL apply already copied media into the piece; its files panel
        // has to be current even though the call failed (mcp/server.ts).
        if (r.data?.partial && pieceId) notify.refreshQuery({ queryKey: "files", pieceId });
        return null;
      }
      notify.refreshQuery({ queryKey: "templates" });
      notify.refreshQuery({ queryKey: "pieces" });
      if (pieceId) notify.refreshQuery({ queryKey: "files", pieceId });
      return pieceId ? { queryKey: "composition", pieceId } : null;
    },
  },
  "libi.delete_template": {
    handler: async (args) =>
      deleteTemplateTool(args as unknown as Parameters<typeof deleteTemplateTool>[0]),
    refresh: (_args, result) =>
      (result as { success?: boolean }).success ? { queryKey: "templates" } : null,
  },
  "libi.list_templates": {
    handler: async (args) =>
      listTemplatesTool(args as unknown as Parameters<typeof listTemplatesTool>[0]),
    refresh: () => null,
  },
  // Prepares a publish request (e2e/templates-publish-review.spec.ts): the
  // review panel appears over the same `templates` refresh the tool emits.
  "libi.publish_template": {
    handler: async (args) =>
      publishTemplate(args as unknown as Parameters<typeof publishTemplate>[0]),
    refresh: (_args, result) =>
      (result as { success?: boolean }).success ? { queryKey: "templates" } : null,
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
  const rawArgs = parsed.args ?? {};
  if (!tool || typeof tool !== "string") {
    return NextResponse.json({ error: "Missing tool name" }, { status: 400 });
  }

  if (!Object.hasOwn(DISPATCH, tool)) {
    return NextResponse.json(
      { error: `Unknown tool: ${tool}` },
      { status: 404 },
    );
  }
  const name = tool as RunToolName;
  const entry = DISPATCH[name];

  const input = await validateToolInput(name, rawArgs);
  if (!input.ok) {
    const text = input.refusal.content[0].text;
    logger.warn({ tag: "e2e", op: "run_tool_refused", tool: name }, "e2e.run-tool refused its arguments");
    return NextResponse.json({ ...input.refusal, success: false, error: text }, { status: 400 });
  }
  const args = input.args;

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
    logger.warn({ tag: "e2e", op: "run_tool_failed", tool: name, err: message }, "e2e.run-tool failed");
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
