import { notify } from "@/mcp/notify";
import type { ToolResult } from "./types";
import { resolveExtensionId, type ShowExtensionParams } from "./schemas";

/**
 * Navigate the user to Agents → Libi MCP, focused on one extension card.
 *
 * Awaited: `navigated` is true only when the studio accepted the request — on
 * a CLI surface with no studio, or with the server down, the agent must not
 * say the page opened.
 *
 * `libi.list_bundled_mcps` used to live next to this. It is gone: libi
 * registers no third-party MCPs, so there is nothing to reconcile against the
 * live tool list. What the user has connected is visible on the Agents page.
 */
export async function showExtension(params: ShowExtensionParams): Promise<ToolResult> {
  const extensionId = resolveExtensionId(params) ?? undefined;
  const navigated = await notify.navigateAgents({ tab: "libi-mcp", ...(extensionId ? { extensionId } : {}) });
  return { success: true, data: { ok: true, navigated } };
}
