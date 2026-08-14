import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** The 12 core tracking tools. Hosted on BOTH the always-on core `libi`
 *  MCP (so the agent always has them) AND the standalone libi-tracking MCP
 *  (packaging parity) via the single shared registerTrackingTools(). */
export const TRACKING_TOOL_NAMES = [
  "libi.compute_object_track",
  "libi.compute_object_track_providers",
  "libi.compute_track_segment",
  "libi.skip_segment",
  "libi.list_track_segments",
  "libi.ground_target",
  "libi.list_tracks",
  "libi.delete_track",
  "libi.add_tracked_overlay",
  "libi.update_tracked_overlay",
  "libi.update_track_result",
  "libi.refine_track_with_sam2",
] as const;

/** Names of tools registered on a McpServer instance. Uses the SDK's
 *  internal `_registeredTools` map (verified against the SDK source). */
export function registeredToolNames(server: McpServer): string[] {
  const reg =
    (server as unknown as { _registeredTools?: Record<string, unknown> })
      ._registeredTools ?? {};
  return Object.keys(reg);
}
