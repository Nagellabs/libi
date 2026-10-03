import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as tools from "@/mcp/tools";
import { VerifyInstallSchema, RemoveBackgroundSchema } from "@/mcp/tools/schemas";
import { registerActionTool } from "@/mcp/tools/action-tool";
import { TRACKING_MERGED_TOOLS } from "@/mcp/tools/families/tracking";

// Accepts both the loose `ToolResult` and the canonical generic
// `ToolResultOf<…>` (tracking tools return the latter) — the sink only
// serializes, so the structural supertype is the right param type.
function makeContent(result: tools.AnyToolResult) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

function makeError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }) }],
    isError: true,
  };
}

/**
 * Register the tracking + background-removal tools on a given MCP server.
 *
 * This is the SINGLE source of truth for the tracking tool surface. It is
 * called from BOTH:
 *  - `mcp/server.ts#createLibiMcpServer()` — the always-on core `libi` MCP.
 *    Hosting the tools here guarantees they are present in EVERY agent
 *    session (claude-agent-acp loads MCP servers at session-creation time;
 *    a separately-spawned tier-2 MCP could race that and leave the agent
 *    with no tracking tools — the exact dogfood failure this fixes).
 *  - `mcp/tracking-mcp/server.ts#createTrackingMcpServer()` — the standalone
 *    `libi serve-mcp-tracking` CLI entry, kept for packaging parity.
 *
 * The two merged tools (`libi.track`, `libi.tracked_overlay`) replace the old per-verb tools; the
 * implementation functions + schemas are unchanged — they still
 * call the Next.js server over HTTP via runJobViaServer, so which MCP hosts
 * them is behavior-neutral. The heavy Python tracking engine stays lazy
 * (tier-2): tools return a structured `tracking_engine_not_installed` error
 * until it is provisioned. Only the *tool surface* is always-on; the
 * ~1 GB / 10-min engine install is still deferred off the boot path.
 */
export function registerTrackingTools(server: McpServer): void {
  // `libi.track` + `libi.tracked_overlay`: the thirteen per-verb tools, merged (mcp/tools/families/tracking.ts).
  for (const merged of TRACKING_MERGED_TOOLS) registerActionTool(server, merged);

  server.registerTool(
    "libi.verify_install",
    {
      description:
        "Check that the libi-tracking engine (uv Python env + ONNX models) is installed and its self-test passes; call it with NO arguments. Returns {ok, installed, missing[], versions}. It speaks ONLY for libi-tracking (another extension's name is refused): to verify others re-call the tool that returned status \"needs_install\", or read `dependencies` on libi.get_install_plan. Call it after tracking_engine_not_installed and after libi.install_tracking_engine; success persists the install the tracking gate reads.",
      inputSchema: VerifyInstallSchema,
    },
    async (params) => {
      try {
        const result = await tools.verifyInstall(params);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );

  server.registerTool(
    "libi.remove_background",
    {
      description:
        "STOP — load the `removing-and-replacing-backgrounds` skill first and follow it (subject pick, local-vs-paid routing, verify-pixels, compose/transplant). Makes an alpha CUTOUT (subject isolated, background transparent) from a VIDEO file: LOCAL + FREE by default (MatAnyone, seeded from libi's subject masks), a long job with live progress. Returns {cutoutFileId}, a VP9-alpha WebM to place with libi.add_overlay over a full-frame background overlay at a LOWER z. `subject`: omit for auto (largest person) or pass a libi.track ground_target bbox. Photos and hard cases use the PAID provider path, owned by the skill; engine:'fal' here only returns its instructions.",
      inputSchema: RemoveBackgroundSchema,
    },
    async (params, extra) => {
      try {
        const result = await tools.removeBackground(params, extra);
        return makeContent(result);
      } catch (err) { return makeError(err); }
    },
  );
}
