import { expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registeredMergedTools } from "@/mcp/tools/action-registry";

/** The tracking tools: the two merged ones (`libi.track` and `libi.tracked_overlay`, each with an `action`),
 *  hosted on BOTH the always-on core `libi` MCP (so the agent always has them) AND the standalone
 *  libi-tracking MCP (packaging parity) via the single shared registerTrackingTools(). The actions
 *  they carry are listed in `TRACK_ACTIONS` / `TRACKED_OVERLAY_ACTIONS`. */
export const TRACKING_TOOL_NAMES = ["libi.track", "libi.tracked_overlay"] as const;

export const TRACK_ACTIONS = [
  "compute",
  "compute_segment",
  "list",
  "list_segments",
  "delete",
  "update_result",
  "skip_segment",
  "ground_target",
  "list_candidates",
  "pick_candidate",
] as const;

export const TRACKED_OVERLAY_ACTIONS = ["add", "update", "verify"] as const;

/** Names of tools registered on a McpServer instance. Uses the SDK's
 *  internal `_registeredTools` map (verified against the SDK source). */
export function registeredToolNames(server: McpServer): string[] {
  const reg =
    (server as unknown as { _registeredTools?: Record<string, unknown> })
      ._registeredTools ?? {};
  return Object.keys(reg);
}

/** `tool` (a merged tracking tool) is on the server and declares `action`. Call it after the server was built. */
export function expectTrackingAction(names: string[], tool: "libi.track" | "libi.tracked_overlay", action: string): void {
  expect(names).toContain(tool);
  expect(registeredMergedTools().get(tool)?.actions, `${tool} actions`).toContain(action);
}
