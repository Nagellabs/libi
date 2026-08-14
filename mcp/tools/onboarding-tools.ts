import { notify } from "@/mcp/notify";
import type { ToolResult } from "./types";
import type { StartOnboardingParams, ShowApiConfigParams } from "./schemas";

/**
 * Re-open the onboarding panel in the right region.
 */
export async function startOnboarding(_params: StartOnboardingParams): Promise<ToolResult> {
  notify.rightRegion({ mode: "onboarding" });
  return { success: true, data: { opened: "onboarding" } };
}

/**
 * Open the inline API-key config panel for a bundled MCP.
 */
export async function showApiConfig(params: ShowApiConfigParams): Promise<ToolResult> {
  notify.rightRegion({ mode: "api-config", mcpId: params.mcpId });
  return { success: true, data: { opened: "api-config", mcpId: params.mcpId } };
}
