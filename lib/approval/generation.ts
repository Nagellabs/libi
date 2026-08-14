import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { parseMcpToolId, type McpToolId } from "@/lib/agents/mcp-tool-id";

const GENERATION_MCP_IDS = new Set<string>(
  BUNDLED_MCP_SERVERS.filter((m) => m.generation === true).map((m) => m.id),
);

/** Returns true if the canonical tool ID belongs to a bundled MCP flagged
 *  `generation: true`. Built-in Claude Code tools (toolId === null) are
 *  never gated. */
export function isGenerationTool(toolId: McpToolId | null): boolean {
  if (!toolId) return false;
  const parsed = parseMcpToolId(toolId);
  if (!parsed) return false;
  return GENERATION_MCP_IDS.has(parsed.serverId);
}
